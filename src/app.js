// app.js
import express from "express";
import cors from "cors";
import redis from "./redis.js";
import pg from "pg";
import dotenv from "dotenv";

// 환경변수 로드
dotenv.config();

const app = express();
const { Pool } = pg;

// PostgreSQL 연결
const pool = new Pool({
    host: process.env.DB_HOST || 'jimo.world',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'postgres',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '1107',
    // 원격 서버 연결시 SSL 설정
    ssl: process.env.DB_HOST !== 'localhost' ? {
        rejectUnauthorized: false
    } : false
});

console.log('📊 DB Config:', {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || '5432',
    database: process.env.DB_NAME || 'employee_mall',
    user: process.env.DB_USER || 'postgres',
    ssl: process.env.DB_HOST !== 'localhost' ? 'enabled' : 'disabled'
});

// 미들웨어
app.use(express.json());
app.use(cors());

// 기본 테스트
app.get("/", (req, res) => {
    res.send("Node + Redis + PostgreSQL 서버 실행 중 🚀");
});

// Redis 카운터 테스트
app.get("/count", async (req, res) => {
    const count = await redis.incr("visits");
    res.send(`현재 방문자 수: ${count}`);
});

// ============================================
// 헬퍼 함수
// ============================================

// Redis 캐시에서 사용자 조회
async function getUserFromCache(employeeId) {
    const cacheKey = `user:${employeeId}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
        return JSON.parse(cached);
    }
    return null;
}

// Redis 캐시에 사용자 저장 (TTL: 1시간)
// Redis 캐시에 사용자 저장 (TTL: 1시간)
async function setUserCache(employeeId, userData) {
    const cacheKey = `user:${employeeId}`;
    await redis.set(cacheKey, JSON.stringify(userData), 'EX', 3600);
}

// Redis 캐시 무효화
async function invalidateUserCache(employeeId) {
    const cacheKey = `user:${employeeId}`;
    await redis.del(cacheKey);
}

// ============================================
// 인증 API
// ============================================

// 1. 일반 로그인 (사번/비밀번호)
app.post("/api/auth/login", async (req, res) => {
    const client = await pool.connect();

    try {
        const { employeeId, password } = req.body;

        if (!employeeId || !password) {
            return res.status(400).json({
                message: "사번과 비밀번호를 입력해주세요."
            });
        }

        // 1. Redis 캐시 확인
        let user = await getUserFromCache(employeeId);

        // 2. 캐시에 없으면 DB 조회
        if (!user) {
            const result = await client.query(
                'SELECT * FROM users WHERE employee_id = $1',
                [employeeId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    message: "등록되지 않은 사번입니다."
                });
            }

            user = result.rows[0];

            // Redis에 캐싱
            await setUserCache(employeeId, user);
        }

        // 비밀번호 확인 (실제로는 bcrypt 사용)
        if (user.password !== password) {
            return res.status(401).json({
                message: "비밀번호가 일치하지 않습니다."
            });
        }

        // 로그인 성공
        res.json({
            name: user.name,
            employeeId: user.employee_id,
            email: user.email
        });

    } catch (error) {
        console.error("Login error:", error);
        res.status(500).json({
            message: "서버 오류가 발생했습니다."
        });
    } finally {
        client.release();
    }
});

// 2. 카카오 로그인
app.post("/api/auth/kakao", async (req, res) => {
    const client = await pool.connect();

    try {
        const { kakaoId, accessToken, name, email } = req.body;

        if (!kakaoId) {
            return res.status(400).json({
                message: "카카오 ID가 필요합니다."
            });
        }

        // 1. Redis에서 카카오 ID 매핑 확인
        const cachedEmployeeId = await redis.get(`kakao:${kakaoId}`);

        let user;
        if (cachedEmployeeId) {
            // 캐시에서 사용자 정보 조회
            user = await getUserFromCache(cachedEmployeeId);

            // 캐시에 없으면 DB 조회
            if (!user) {
                const result = await client.query(
                    'SELECT * FROM public.users WHERE employee_id = $1',
                    [cachedEmployeeId]
                );
                user = result.rows[0];
                if (user) {
                    await setUserCache(user.employee_id, user);
                }
            }
        } else {
            // 2. DB에서 카카오 ID로 사용자 검색
            const result = await client.query(
                'SELECT * FROM public.users WHERE kakao_id = $1',
                [kakaoId]
            );

            if (result.rows.length > 0) {
                user = result.rows[0];
                // Redis에 매핑 및 캐싱
                await redis.set(`kakao:${kakaoId}`, user.employee_id);
                await setUserCache(user.employee_id, user);
            }
        }

        if (user) {
            // 기존 회원
            res.json({
                isRegistered: true,
                name: user.name,
                employeeId: user.employee_id,
                email: user.email
            });
        } else {
            // 신규 회원
            res.json({
                isRegistered: false,
                kakaoName: name,
                kakaoEmail: email
            });
        }

    } catch (error) {
        console.error("Kakao login error:", error);
        res.status(500).json({
            message: "카카오 로그인 처리 중 오류가 발생했습니다."
        });
    } finally {
        client.release();
    }
});

// 3. 회원가입
app.post("/api/auth/signup", async (req, res) => {
    const client = await pool.connect();

    try {
        const { employeeId, password, name, email, phone, address, kakaoId, marketingAgreed } = req.body;

        if (!employeeId || !name) {
            return res.status(400).json({
                message: "필수 정보를 입력해주세요."
            });
        }

        // 트랜잭션 시작
        await client.query('BEGIN');

        // 1. 이미 존재하는 사번인지 확인
        const existCheck = await client.query(
            'SELECT employee_id FROM users WHERE employee_id = $1',
            [employeeId]
        );

        if (existCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({
                message: "이미 등록된 사번입니다."
            });
        }

        // 2. DB에 사용자 정보 저장
        const insertResult = await client.query(
            `INSERT INTO users (employee_id, password, name, email, phone, address, kakao_id, marketing_agreed, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
             RETURNING *`,
            [employeeId, password || '', name, email || '', phone || '', address || '', kakaoId || null, marketingAgreed || false]
        );

        const newUser = insertResult.rows[0];

        // 3. 카카오 ID 매핑 저장 (Redis)
        if (kakaoId) {
            await redis.set(`kakao:${kakaoId}`, employeeId);
        }

        // 4. 사용자 정보 캐싱 (Redis)
        await setUserCache(employeeId, newUser);

        // 트랜잭션 커밋
        await client.query('COMMIT');

        res.status(201).json({
            message: "회원가입이 완료되었습니다.",
            name,
            employeeId
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Signup error:", error);
        res.status(500).json({
            message: "회원가입 처리 중 오류가 발생했습니다."
        });
    } finally {
        client.release();
    }
});

// 4. 사용자 정보 조회
app.get("/api/user/:employeeId", async (req, res) => {
    const client = await pool.connect();

    try {
        const { employeeId } = req.params;

        // 1. Redis 캐시 확인
        let user = await getUserFromCache(employeeId);

        // 2. 캐시에 없으면 DB 조회
        if (!user) {
            const result = await client.query(
                'SELECT * FROM users WHERE employee_id = $1',
                [employeeId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    message: "사용자를 찾을 수 없습니다."
                });
            }

            user = result.rows[0];
            await setUserCache(employeeId, user);
        }

        // 비밀번호는 제외하고 반환
        const { password, ...userData } = user;

        res.json(userData);

    } catch (error) {
        console.error("Get user error:", error);
        res.status(500).json({
            message: "사용자 정보 조회 중 오류가 발생했습니다."
        });
    } finally {
        client.release();
    }
});

// 5. 사용자 정보 수정
app.put("/api/user/:employeeId", async (req, res) => {
    const client = await pool.connect();

    try {
        const { employeeId } = req.params;
        const { name, email, phone, address } = req.body;

        await client.query('BEGIN');

        // DB 업데이트
        const result = await client.query(
            `UPDATE users 
             SET name = COALESCE($1, name),
                 email = COALESCE($2, email),
                 phone = COALESCE($3, phone),
                 address = COALESCE($4, address),
                 updated_at = NOW()
             WHERE employee_id = $5
             RETURNING *`,
            [name, email, phone, address, employeeId]
        );

        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                message: "사용자를 찾을 수 없습니다."
            });
        }

        // Redis 캐시 무효화
        await invalidateUserCache(employeeId);

        await client.query('COMMIT');

        res.json({
            message: "사용자 정보가 수정되었습니다.",
            user: result.rows[0]
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Update user error:", error);
        res.status(500).json({
            message: "사용자 정보 수정 중 오류가 발생했습니다."
        });
    } finally {
        client.release();
    }
});

// ============================================
// 개발용: DB 초기화 및 테스트 데이터
// ============================================

// DB 테이블 생성
app.post("/api/dev/init-db", async (req, res) => {
    const client = await pool.connect();

    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                employee_id VARCHAR(50) UNIQUE NOT NULL,
                password VARCHAR(255),
                name VARCHAR(100) NOT NULL,
                email VARCHAR(255),
                phone VARCHAR(20),
                address TEXT,
                kakao_id VARCHAR(100) UNIQUE,
                marketing_agreed BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            );

            CREATE INDEX IF NOT EXISTS idx_employee_id ON users(employee_id);
            CREATE INDEX IF NOT EXISTS idx_kakao_id ON users(kakao_id);
        `);

        res.json({
            message: "데이터베이스 테이블이 생성되었습니다."
        });

    } catch (error) {
        console.error("Init DB error:", error);
        res.status(500).json({
            message: "데이터베이스 초기화 실패",
            error: error.message
        });
    } finally {
        client.release();
    }
});

// 테스트 사용자 생성
app.post("/api/dev/create-test-user", async (req, res) => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const testUser = {
            employeeId: "12345",
            password: "test1234",
            name: "홍길동",
            email: "hong@kpmg.com",
            phone: "010-1234-5678",
            address: "서울특별시 강남구 테헤란로 123"
        };

        const result = await client.query(
            `INSERT INTO users (employee_id, password, name, email, phone, address)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (employee_id) DO UPDATE 
             SET password = $2, name = $3, email = $4, phone = $5, address = $6
             RETURNING *`,
            [testUser.employeeId, testUser.password, testUser.name,
                testUser.email, testUser.phone, testUser.address]
        );

        // Redis에 캐싱
        await setUserCache(testUser.employeeId, result.rows[0]);

        await client.query('COMMIT');

        res.json({
            message: "테스트 사용자 생성 완료",
            user: result.rows[0]
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Create test user error:", error);
        res.status(500).json({
            message: "테스트 사용자 생성 실패",
            error: error.message
        });
    } finally {
        client.release();
    }
});

// Redis 캐시 초기화
app.post("/api/dev/clear-cache", async (req, res) => {
    try {
        await redis.flushDb();
        res.json({
            message: "Redis 캐시가 초기화되었습니다."
        });
    } catch (error) {
        console.error("Clear cache error:", error);
        res.status(500).json({
            message: "캐시 초기화 실패"
        });
    }
});

// ============================================
// 서버 시작
// ============================================
const PORT = 3000;
app.listen(PORT, async () => {
    console.log(`\n🚀 Server running at http://localhost:${PORT}\n`);

    // DB 연결 테스트
    console.log('🔌 PostgreSQL 연결 테스트 중...');
    try {
        const result = await pool.query('SELECT NOW()');
        console.log('✅ PostgreSQL 연결 성공');
        console.log('   서버 시간:', result.rows[0].now);
    } catch (error) {
        console.error('❌ PostgreSQL 연결 실패');
        console.error('   에러 코드:', error.code);
        console.error('   에러 메시지:', error.message);
        console.error('   상세 정보:', {
            host: pool.options.host,
            port: pool.options.port,
            database: pool.options.database,
            user: pool.options.user,
        });
        console.error('   전체 에러:', error);
    }

    // Redis 연결 테스트
    console.log('\n🔌 Redis 연결 테스트 중...');
    try {
        await redis.ping();
        console.log('✅ Redis 연결 성공');
    } catch (error) {
        console.error('❌ Redis 연결 실패');
        console.error('   에러 메시지:', error.message);
        console.error('   전체 에러:', error);
    }

    console.log(`\n📝 API Endpoints:`);
    console.log(`   POST /api/auth/login - 일반 로그인`);
    console.log(`   POST /api/auth/kakao - 카카오 로그인`);
    console.log(`   POST /api/auth/signup - 회원가입`);
    console.log(`   GET  /api/user/:employeeId - 사용자 조회`);
    console.log(`   PUT  /api/user/:employeeId - 사용자 수정`);
    console.log(`\n🛠️  Dev Endpoints:`);
    console.log(`   POST /api/dev/init-db - DB 테이블 생성`);
    console.log(`   POST /api/dev/create-test-user - 테스트 사용자 생성`);
    console.log(`   POST /api/dev/clear-cache - Redis 캐시 초기화`);
});