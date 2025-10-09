// app.js
import express from "express";
import cors from "cors";
import redis from "./redis.js";
import pg from "pg";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";

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
const JWT_SECRET = process.env.JWT_SECRET || "supersecretkey";
const TOKEN_EXPIRES_IN = "6h"; // 6시간 유효

// ===================================================
// 🔐 JWT 헬퍼 함수
// ===================================================

// 토큰 생성
function generateToken(user) {
    return jwt.sign(
        {
            employeeId: user.employee_id,
            role: user.role,
            name: user.name
        },
        JWT_SECRET,
        { expiresIn: TOKEN_EXPIRES_IN }
    );
}

// 토큰 검증 미들웨어
function verifyToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ message: "토큰이 필요합니다." });
    }

    const token = authHeader.split(" ")[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded; // req.user에 디코딩된 정보 저장
        next();
    } catch (error) {
        return res.status(403).json({ message: "유효하지 않은 토큰입니다." });
    }
}

// Role 검증 미들웨어
function requireRole(role) {
    return (req, res, next) => {
        if (!req.user || req.user.role !== role) {
            return res.status(403).json({ message: "권한이 없습니다." });
        }
        next();
    };
}



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
// 1. 일반 로그인 (사번/비밀번호)
app.post("/api/auth/login", async (req, res) => {
    const client = await pool.connect();

    try {
        const { employeeId, password } = req.body;
        if (!employeeId || !password) {
            return res.status(400).json({ message: "사번과 비밀번호를 입력해주세요." });
        }

        let user = await getUserFromCache(employeeId);
        if (!user) {
            const result = await client.query('SELECT * FROM users WHERE employee_id = $1', [employeeId]);
            if (result.rows.length === 0) {
                return res.status(404).json({ message: "등록되지 않은 사번입니다." });
            }
            user = result.rows[0];
            await setUserCache(employeeId, user);
        }

        // 🔐 bcrypt로 비밀번호 비교
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ message: "비밀번호가 일치하지 않습니다." });
        }

        // ✅ JWT 토큰 발급
        const token = generateToken(user);

        res.json({
            message: "로그인 성공",
            token,
            user: {
                name: user.name,
                employeeId: user.employee_id,
                email: user.email,
                role: user.role
            }
        });

    } catch (error) {
        console.error("Login error:", error);
        res.status(500).json({ message: "서버 오류가 발생했습니다." });
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
                    'SELECT * FROM users WHERE employee_id = $1',
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
                'SELECT * FROM users WHERE kakao_id = $1',
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
            // ✅ 기존 회원 - JWT 토큰 발급
            const token = generateToken(user);

            return res.json({
                isRegistered: true,
                token,
                user: {
                    name: user.name,
                    employeeId: user.employee_id,
                    email: user.email,
                    role: user.role
                }
            });
        } else {
            // 신규 회원
            return res.json({
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
        const hashedPassword = password ? await bcrypt.hash(password, 10) : '';

        const insertResult = await client.query(
            `INSERT INTO users (employee_id, password, name, email, phone, address, kakao_id, marketing_agreed, role, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     RETURNING *`,
            [employeeId, hashedPassword, name, email || '', phone || '', address || '', kakaoId || null, marketingAgreed || false, role || 'user']
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
app.get("/api/user/:employeeId",verifyToken, async (req, res) => {
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
app.put("/api/user/:employeeId",verifyToken, async (req, res) => {
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
app.post("/api/dev/init-db",verifyToken, requireRole("admin"), async (req, res) => {
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
                role VARCHAR(20) DEFAULT 'user',   -- ✅ 추가
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
app.post("/api/dev/create-test-user",  verifyToken, requireRole("admin"),async (req, res) => {
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
app.post("/api/dev/clear-cache", verifyToken, async (req, res) => {
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

// 현재 판매중인 상품 조회
app.get("/api/sale/current", verifyToken, async (req, res) => {
    const client = await pool.connect();

    try {
        // 현재 시간 기준으로 판매 정보 조회
        const result = await client.query(`
            SELECT 
                p.*,
                s.id as sale_id,
                s.sale_start,
                s.sale_end,
                s.total_stock,
                s.remaining_stock,
                s.status as sale_status,
                CASE
                    WHEN NOW() < s.sale_start THEN 'before'
                    WHEN NOW() >= s.sale_start AND NOW() < s.sale_end AND s.remaining_stock > 0 THEN 'during'
                    ELSE 'after'
                END as current_status,
                EXTRACT(EPOCH FROM (s.sale_start - NOW())) as seconds_until_start
            FROM products p
            JOIN sales s ON p.id = s.product_id
            ORDER BY s.sale_start DESC
            LIMIT 1
        `);

        if (result.rows.length === 0) {
            return res.status(404).json({
                message: "판매 정보가 없습니다."
            });
        }

        const data = result.rows[0];

        res.json({
            product: {
                id: data.id,
                name: data.name,
                spec: data.spec,
                price: data.price,
                stock: data.stock,
                emoji: data.emoji,
                description: data.description
            },
            sale: {
                id: data.sale_id,
                saleStart: data.sale_start,
                saleEnd: data.sale_end,
                totalStock: data.total_stock,
                remainingStock: data.remaining_stock,
                status: data.current_status,
                secondsUntilStart: Math.max(0, data.seconds_until_start)
            }
        });

    } catch (error) {
        console.error("Get current sale error:", error);
        res.status(500).json({
            message: "판매 정보 조회 중 오류가 발생했습니다."
        });
    } finally {
        client.release();
    }
});

// 상품 목록 조회
app.get("/api/products", verifyToken, async (req, res) => {
    const client = await pool.connect();

    try {
        const result = await client.query(`
            SELECT * FROM products
            ORDER BY created_at DESC
        `);

        res.json(result.rows);

    } catch (error) {
        console.error("Get products error:", error);
        res.status(500).json({
            message: "상품 목록 조회 중 오류가 발생했습니다."
        });
    } finally {
        client.release();
    }
});

// 상품 상세 조회
app.get("/api/products/:id", verifyToken,  async (req, res) => {
    const client = await pool.connect();

    try {
        const { id } = req.params;

        const result = await client.query(
            'SELECT * FROM products WHERE id = $1',
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                message: "상품을 찾을 수 없습니다."
            });
        }

        res.json(result.rows[0]);

    } catch (error) {
        console.error("Get product error:", error);
        res.status(500).json({
            message: "상품 조회 중 오류가 발생했습니다."
        });
    } finally {
        client.release();
    }
});

// 회원 탈퇴
app.delete("/api/user/:employeeId",  verifyToken,async (req, res) => {
    const client = await pool.connect();

    try {
        const { employeeId } = req.params;

        await client.query('BEGIN');

        // 사용자 존재 확인
        const userCheck = await client.query(
            'SELECT * FROM users WHERE employee_id = $1',
            [employeeId]
        );

        if (userCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                message: "사용자를 찾을 수 없습니다."
            });
        }

        const user = userCheck.rows[0];

        // DB에서 사용자 삭제
        await client.query(
            'DELETE FROM users WHERE employee_id = $1',
            [employeeId]
        );

        // Redis 캐시 삭제
        await invalidateUserCache(employeeId);

        // 카카오 ID 매핑도 삭제
        if (user.kakao_id) {
            await redis.del(`kakao:${user.kakao_id}`);
        }

        await client.query('COMMIT');

        res.json({
            message: "회원 탈퇴가 완료되었습니다."
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Delete user error:", error);
        res.status(500).json({
            message: "회원 탈퇴 처리 중 오류가 발생했습니다."
        });
    } finally {
        client.release();
    }
});

// 5. 사용자 정보 수정
app.put("/api/user/:employeeId", verifyToken, async (req, res) => {
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

        // 비밀번호 제외하고 반환
        const { password, ...userData } = result.rows[0];

        res.json({
            message: "사용자 정보가 수정되었습니다.",
            user: userData
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
// 서버 시작
// ============================================
// 관리자 API
app.post("/api/admin/products", verifyToken, requireRole("admin"), async (req, res) => {
    const client = await pool.connect();

    try {
        const { name, spec, price, stock, emoji, description, features, detailImages, releaseDate } = req.body;

        if (!name || !price) {
            return res.status(400).json({ message: "상품명과 가격은 필수입니다." });
        }

        const result = await client.query(
            `INSERT INTO products (name, spec, price, stock, emoji, description, features, detail_images, release_date, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft')
             RETURNING *`,
            [name, spec || '', price, stock || 0, emoji || '', description || '', features || [], detailImages || [], releaseDate || null]
        );

        res.status(201).json({
            message: "상품이 등록되었습니다.",
            product: result.rows[0]
        });

    } catch (error) {
        console.error("Create product error:", error);
        res.status(500).json({ message: "상품 등록 중 오류가 발생했습니다." });
    } finally {
        client.release();
    }
});

app.put("/api/admin/products/:id", verifyToken, requireRole("admin"), async (req, res) => {
    const client = await pool.connect();

    try {
        const { id } = req.params;
        const { name, spec, price, stock, emoji, description, features, detailImages } = req.body;

        const result = await client.query(
            `UPDATE products
             SET name = COALESCE($1, name),
                 spec = COALESCE($2, spec),
                 price = COALESCE($3, price),
                 stock = COALESCE($4, stock),
                 emoji = COALESCE($5, emoji),
                 description = COALESCE($6, description),
                 features = COALESCE($7, features),
                 detail_images = COALESCE($8, detail_images),
                 updated_at = NOW()
             WHERE id = $9
             RETURNING *`,
            [name, spec, price, stock, emoji, description, features, detailImages, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: "상품을 찾을 수 없습니다." });
        }

        res.json({ message: "상품이 수정되었습니다.", product: result.rows[0] });

    } catch (error) {
        console.error("Update product error:", error);
        res.status(500).json({ message: "상품 수정 중 오류가 발생했습니다." });
    } finally {
        client.release();
    }
});

app.patch("/api/admin/products/:id/stock", verifyToken, requireRole("admin"), async (req, res) => {
    const client = await pool.connect();

    try {
        const { id } = req.params;
        const { stock } = req.body;

        if (stock == null || isNaN(stock)) {
            return res.status(400).json({ message: "유효한 재고 수량을 입력해주세요." });
        }

        const result = await client.query(
            `UPDATE products
             SET stock = $1,
                 updated_at = NOW()
             WHERE id = $2
             RETURNING *`,
            [stock, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: "상품을 찾을 수 없습니다." });
        }

        res.json({ message: "재고가 수정되었습니다.", product: result.rows[0] });

    } catch (error) {
        console.error("Update stock error:", error);
        res.status(500).json({ message: "재고 수정 중 오류가 발생했습니다." });
    } finally {
        client.release();
    }
});

app.patch("/api/admin/products/:id/release", verifyToken, requireRole("admin"), async (req, res) => {
    const client = await pool.connect();

    try {
        const { id } = req.params;
        const { releaseDate } = req.body;

        const result = await client.query(
            `UPDATE products
             SET release_date = $1,
                 status = 'scheduled',
                 updated_at = NOW()
             WHERE id = $2
             RETURNING *`,
            [releaseDate, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: "상품을 찾을 수 없습니다." });
        }

        res.json({ message: "출시일이 설정되었습니다.", product: result.rows[0] });

    } catch (error) {
        console.error("Set release date error:", error);
        res.status(500).json({ message: "출시일 설정 중 오류가 발생했습니다." });
    } finally {
        client.release();
    }
});

app.patch("/api/admin/products/:id/status", verifyToken, requireRole("admin"), async (req, res) => {
    const client = await pool.connect();

    try {
        const { id } = req.params;
        const { status } = req.body; // active | stopped | draft | scheduled

        if (!["active", "stopped", "draft", "scheduled"].includes(status)) {
            return res.status(400).json({ message: "유효하지 않은 상태입니다." });
        }

        const result = await client.query(
            `UPDATE products
             SET status = $1,
                 updated_at = NOW()
             WHERE id = $2
             RETURNING *`,
            [status, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: "상품을 찾을 수 없습니다." });
        }

        res.json({ message: "상태가 변경되었습니다.", product: result.rows[0] });

    } catch (error) {
        console.error("Update status error:", error);
        res.status(500).json({ message: "상태 변경 중 오류가 발생했습니다." });
    } finally {
        client.release();
    }
});

app.get("/api/admin/products", verifyToken, requireRole("admin"), async (req, res) => {
    const client = await pool.connect();

    try {
        const result = await client.query(
            `SELECT * FROM products ORDER BY created_at DESC`
        );

        res.json(result.rows);

    } catch (error) {
        console.error("Get admin products error:", error);
        res.status(500).json({ message: "상품 목록 조회 중 오류가 발생했습니다." });
    } finally {
        client.release();
    }
});

// ✅ 관리자 상품 목록
app.get("/api/admin/products", verifyToken, requireRole("admin"), async (req, res) => {
    const client = await pool.connect();
    try {
        const result = await client.query("SELECT * FROM products ORDER BY created_at DESC");
        res.json(result.rows);
    } catch (error) {
        console.error("Get admin products error:", error);
        res.status(500).json({ message: "상품 목록 조회 실패" });
    } finally {
        client.release();
    }
});

// ✅ 재고 수정
app.patch("/api/admin/products/:id/stock", verifyToken, requireRole("admin"), async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        const { stock } = req.body;
        await client.query("UPDATE products SET stock = $1, updated_at = NOW() WHERE id = $2", [stock, id]);
        res.json({ message: "재고 수정 완료" });
    } catch (error) {
        console.error("Update stock error:", error);
        res.status(500).json({ message: "재고 수정 실패" });
    } finally {
        client.release();
    }
});

// ✅ 판매 상태 변경
app.patch("/api/admin/products/:id/status", verifyToken, requireRole("admin"), async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        const { status } = req.body;
        await client.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'draft'");
        await client.query("UPDATE products SET status = $1, updated_at = NOW() WHERE id = $2", [status, id]);
        res.json({ message: "상태 변경 완료" });
    } catch (error) {
        console.error("Change status error:", error);
        res.status(500).json({ message: "상태 변경 실패" });
    } finally {
        client.release();
    }
});

const PORT = 5000;
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