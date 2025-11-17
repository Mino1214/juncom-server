// app.js
import express from "express";
import cors from "cors";
import redis from "./redis.js";
import pg from "pg";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import multer from "multer";
import path from "path";
import fs from "fs";
import bcrypt from "bcryptjs";
import emailService from "./email.service.js";
import addressRoutes from './routes/address.js';
import paymentRoutes from './routes/payment.js';
// 🔥 큐 워커 초기화를 위해 import
import './routes/orderQueue.js';
// 📁 최상단에 import 추가
import { fileURLToPath } from "url";
import { dirname } from "path";
import AddressService from "./address.service.js";
// 환경변수 로드
dotenv.config();

// 업로드 폴더 생성
const uploadDir = "uploads";
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// multer 설정
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `product-${Date.now()}${ext}`);
    }
});
const upload = multer({ storage });
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
const TOKEN_EXPIRES_IN = "365d"; // 6시간 유효

// ===================================================
// 🔐 JWT 헬퍼 함수
// ===================================================

// 토큰 생성
function generateToken(user) {
    return jwt.sign(
        {
            email: user.email,   // ← email만 사용
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


// CORS 설정 추가 (반드시 다른 미들웨어보다 먼저!)
app.use(cors({
    origin: [
        'https://jimo.world',
        'http://localhost:3000',
        'http://localhost:5174',  // Vite 개발 서버,
        'https://cleanupsystems.shop'
    ],
    // origin: "*",
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
// 미들웨어
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(addressRoutes);
app.use('/api/payment', paymentRoutes);
// 👇👇👇 여기에 추가!
app.use((req, res, next) => {
    console.log(`🔥 ${new Date().toISOString()} - ${req.method} ${req.path}`);
    console.log('Headers:', req.headers);
    console.log('Body:', req.body);
    next();
});


// ============================================
// 사원 상태 관리 API
// ============================================
app.put('/api/delivery/:orderId', async (req, res) => {
    const { orderId } = req.params;
    const {
        recipient_name,
        delivery_address,
        delivery_detail_address,
        delivery_phone,
        delivery_request
    } = req.body;

    try {
        const result = await pool.query(
            `UPDATE orders
       SET recipient_name = $1,
           delivery_address = $2,
           delivery_detail_address = $3,
           delivery_phone = $4,
           delivery_request = $5,
           updated_at = NOW()
       WHERE order_id = $6
       RETURNING *`,
            [recipient_name, delivery_address, delivery_detail_address, delivery_phone, delivery_request, orderId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: '주문을 찾을 수 없습니다.' });
        }

        res.json({ success: true, order: result.rows[0] });
    } catch (error) {
        console.error('배송정보 수정 실패:', error);
        res.status(500).json({ success: false, message: '배송정보 수정 실패' });
    }
});
// 1. 사원 상태 조회
app.get("/api/employee/status/check", async (req, res) => {
    const client = await pool.connect();

    try {
        const { email } = req.query;

        if (!email) {
            return res.status(400).json({
                success: false,
                message: "이메일을 입력해주세요."
            });
        }

        // 1️⃣ 블랙리스트 검사
        const blacklistResult = await client.query(
            "SELECT * FROM employee_status WHERE email = $1",
            [email]
        );

        let isBlacklisted = false;
        let blacklistInfo = null;

        if (blacklistResult.rows.length > 0) {
            const row = blacklistResult.rows[0];
            isBlacklisted = row.status === "blacklisted";
            blacklistInfo = {
                status: row.status,
                reason: row.reason,
                updated_at: row.updated_at
            };
        }

        // 2️⃣ 이메일 중복 검사
        const userCheck = await client.query(
            "SELECT id FROM users WHERE email = $1",
            [email]
        );
        const isDuplicate = userCheck.rows.length > 0;

        // 3️⃣ 결과 반환
        if (isBlacklisted) {
            return res.status(200).json({
                success: true,
                is_blacklisted: true,
                is_duplicate: false,
                message: "블랙리스트에 등록된 사용자입니다.",
                data: blacklistInfo
            });
        }

        if (isDuplicate) {
            return res.status(200).json({
                success: true,
                is_blacklisted: false,
                is_duplicate: true,
                message: "이미 가입된 이메일입니다."
            });
        }

        // 정상
        res.status(200).json({
            success: true,
            is_blacklisted: false,
            is_duplicate: false,
            message: "정상 사용자입니다."
        });
    } catch (error) {
        console.error("사원 상태 조회 오류:", error);
        res.status(500).json({
            success: false,
            message: "서버 오류가 발생했습니다."
        });
    } finally {
        client.release();
    }
});// 2. 사원 등록/수정 (상태 설정)
app.post("/api/employee/status", verifyToken, requireRole("admin"), async (req, res) => {
    const client = await pool.connect();

    try {
        const { employee_id, email, status, reason, registered_by } = req.body;

        if (!employee_id || !email || !status) {
            return res.status(400).json({
                success: false,
                message: '사원번호, 이메일, 상태를 모두 입력해주세요.'
            });
        }

        if (!['normal', 'blacklisted'].includes(status)) {
            return res.status(400).json({
                success: false,
                message: '유효하지 않은 상태값입니다. (normal 또는 blacklisted)'
            });
        }

        await client.query('BEGIN');

        // UPSERT: 존재하면 업데이트, 없으면 삽입
        const result = await client.query(
            `INSERT INTO employee_status (employee_id, email, status, reason, registered_by)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (employee_id, email) 
             DO UPDATE SET 
                 status = $3,
                 reason = $4,
                 registered_by = $5,
                 updated_at = NOW()
             RETURNING *`,
            [employee_id, email, status, reason || null, registered_by || req.user.name]
        );

        await client.query('COMMIT');

        res.status(200).json({
            success: true,
            message: '사원 상태가 설정되었습니다.',
            data: result.rows[0]
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('사원 상태 설정 오류:', error);

        if (error.code === '23505') {
            return res.status(409).json({
                success: false,
                message: '이미 등록된 사원번호와 이메일 조합입니다.'
            });
        }

        res.status(500).json({
            success: false,
            message: '서버 오류가 발생했습니다.'
        });
    } finally {
        client.release();
    }
});

// 3. 블랙리스트 전체 조회 (관리자용)
app.get("/api/admin/employee/blacklist", verifyToken, requireRole("admin"), async (req, res) => {
    const client = await pool.connect();

    try {
        const { employee_id, email, status } = req.query;

        let query = 'SELECT * FROM employee_status WHERE 1=1';
        const params = [];
        let paramIndex = 1;

        if (status) {
            query += ` AND status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
        }

        if (employee_id) {
            query += ` AND employee_id = $${paramIndex}`;
            params.push(employee_id);
            paramIndex++;
        }

        if (email) {
            query += ` AND email ILIKE $${paramIndex}`;
            params.push(`%${email}%`);
            paramIndex++;
        }

        query += ' ORDER BY updated_at DESC';

        const result = await client.query(query, params);

        res.status(200).json({
            success: true,
            count: result.rows.length,
            data: result.rows
        });

    } catch (error) {
        console.error('블랙리스트 조회 오류:', error);
        res.status(500).json({
            success: false,
            message: '서버 오류가 발생했습니다.'
        });
    } finally {
        client.release();
    }
});

// 4. 사원 상태 변경 (normal ↔ blacklisted)
app.patch("/api/admin/employee/status/:id", verifyToken, requireRole("admin"), async (req, res) => {
    const client = await pool.connect();

    try {
        const { id } = req.params;
        const { status, reason } = req.body;

        if (!['normal', 'blacklisted'].includes(status)) {
            return res.status(400).json({
                success: false,
                message: '유효하지 않은 상태값입니다.'
            });
        }

        const result = await client.query(
            `UPDATE employee_status 
             SET status = $1, 
                 reason = $2,
                 updated_at = NOW()
             WHERE id = $3
             RETURNING *`,
            [status, reason || null, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: '해당 사원 정보를 찾을 수 없습니다.'
            });
        }

        res.status(200).json({
            success: true,
            message: '사원 상태가 변경되었습니다.',
            data: result.rows[0]
        });

    } catch (error) {
        console.error('사원 상태 변경 오류:', error);
        res.status(500).json({
            success: false,
            message: '서버 오류가 발생했습니다.'
        });
    } finally {
        client.release();
    }
});

// 5. 사원 정보 삭제
// 회원 탈퇴
// 회원 탈퇴
// 회원 탈퇴
// app.delete("/api/user/:employeeId", verifyToken, async (req, res) => {
//     const client = await pool.connect();
//
//     try {
//         const { employeeId } = req.params;
//
//         await client.query('BEGIN');
//
//         // 1️⃣ 탈퇴할 유저 정보를 먼저 가져와서 email 확보
//         const userCheck = await client.query(
//             'SELECT * FROM users WHERE employee_id = $1',
//             [employeeId]
//         );
//
//         if (userCheck.rows.length === 0) {
//             await client.query('ROLLBACK');
//             return res.status(404).json({
//                 message: "사용자를 찾을 수 없습니다."
//             });
//         }
//
//         const user = userCheck.rows[0];
//         const email = user.email;  // ⭐ 캐시 삭제에 반드시 필요한 key
//
//         // 2️⃣ Redis 캐시 삭제 (email 기반)
//         if (email) {
//             await invalidateUserCache(email);
//             // → 실제 삭제되는 key: user:email@example.com
//         }
//
//         // 3️⃣ DB에서 사용자 삭제
//         await client.query(
//             'DELETE FROM users WHERE employee_id = $1',
//             [employeeId]
//         );
//
//         await client.query('COMMIT');
//
//         return res.json({
//             message: "회원 탈퇴가 완료되었습니다."
//         });
//
//     } catch (error) {
//         await client.query('ROLLBACK');
//         console.error("Delete user error:", error);
//         return res.status(500).json({
//             message: "회원 탈퇴 처리 중 오류가 발생했습니다."
//         });
//     } finally {
//         client.release();
//     }
// });



app.post("/api/send-verification", async (req, res) => {
    console.log("✅ HANDLER CALLED!!!");
    let client;

    try {
        client = await pool.connect();
        const { email } = req.body;  // employeeId 안 받음!

        if (!email) {
            return res.status(400).json({ message: "이메일을 입력해주세요." });
        }

        await client.query('BEGIN');

        // 기존 인증코드 삭제 (이메일 기준)
        await client.query(
            'DELETE FROM email_verifications WHERE email = $1 AND verified = false',
            [email]
        );

        const verificationCode = emailService.generateVerificationCode();
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

        // employee_id 없이 저장
        await client.query(
            `INSERT INTO email_verifications (email, code, expires_at)
             VALUES ($1, $2, $3)`,
            [email, verificationCode, expiresAt]
        );

        await emailService.sendVerificationEmail(email, verificationCode, '');

        await client.query('COMMIT');

        res.json({
            message: "인증번호가 이메일로 발송되었습니다.",
            expiresIn: 300
        });

    } catch (error) {
        console.error("💥 에러:", error);
        if (client) await client.query('ROLLBACK');
        res.status(500).json({
            message: "인증번호 발송 중 오류가 발생했습니다.",
            error: error.message
        });
    } finally {
        if (client) client.release();
    }
});// 2. 인증번호 검증 API
app.post("/api/verify-code", async (req, res) => {
    console.log("✅ verify-code 호출됨!");
    let client;

    try {
        console.log("1️⃣ 받은 데이터:", req.body);
        const { email, code } = req.body;

        if (!email || !code) {
            console.log("❌ 파라미터 누락");
            return res.status(400).json({ message: "이메일과 인증번호를 입력해주세요." });
        }

        console.log("2️⃣ DB 연결 시도...");
        client = await pool.connect();
        console.log("✅ DB 연결 성공");

        console.log("3️⃣ 트랜잭션 시작...");
        await client.query('BEGIN');
        console.log("✅ 트랜잭션 시작됨");

        console.log("4️⃣ 인증번호 조회 - email:", email, "code:", code);
        const result = await client.query(
            `SELECT * FROM email_verifications 
             WHERE email = $1 
             AND code = $2 
             AND verified = false 
             ORDER BY created_at DESC 
             LIMIT 1`,
            [email, code]
        );
        console.log("✅ 쿼리 완료, 결과:", result.rows.length, "건");

        if (result.rows.length > 0) {
            console.log("📋 찾은 데이터:", result.rows[0]);
        }

        if (result.rows.length === 0) {
            console.log("❌ 인증번호 불일치");
            await client.query('ROLLBACK');
            return res.status(400).json({ message: "인증번호가 일치하지 않습니다." });
        }

        const verification = result.rows[0];
        console.log("5️⃣ 만료 시간 확인...");
        console.log("현재 시간:", new Date());
        console.log("만료 시간:", new Date(verification.expires_at));

        if (new Date() > new Date(verification.expires_at)) {
            console.log("❌ 인증번호 만료됨");
            await client.query('ROLLBACK');
            return res.status(400).json({ message: "인증번호가 만료되었습니다." });
        }
        console.log("✅ 만료 안됨");

        console.log("6️⃣ 인증 완료 처리...");
        await client.query(
            `UPDATE email_verifications 
             SET verified = true 
             WHERE id = $1`,
            [verification.id]
        );
        console.log("✅ 업데이트 완료");

        await client.query('COMMIT');
        console.log("✅ 커밋 완료");

        console.log("7️⃣ 토큰 생성...");
        const verificationToken = jwt.sign(
            {
                email: verification.email,
                verified: true
            },
            JWT_SECRET,
            { expiresIn: '5m' }
        );
        console.log("✅ 토큰 생성됨");

        console.log("8️⃣ 응답 전송!");
        res.json({
            message: "이메일 인증이 완료되었습니다.",
            verificationToken
        });

    } catch (error) {
        console.error("💥💥💥 에러 발생:", error);
        console.error("에러 스택:", error.stack);
        if (client) {
            try {
                await client.query('ROLLBACK');
            } catch (e) {
                console.error("롤백 에러:", e);
            }
        }
        res.status(500).json({ message: "인증번호 확인 중 오류가 발생했습니다." });
    } finally {
        if (client) {
            client.release();
            console.log("✅ DB 연결 해제");
        }
    }
});// ============================================
// 3. 인증 이력 조회 (선택사항 - 관리자용)
// ============================================
app.get("/api/admin/verifications/:email", verifyToken, requireRole("admin"), async (req, res) => {
    const client = await pool.connect();

    try {
        const { email } = req.params;  // employeeId → email

        const result = await client.query(
            `SELECT id, employee_id, email, code, verified, expires_at, created_at 
             FROM email_verifications 
             WHERE email = $1 
             ORDER BY created_at DESC 
             LIMIT 10`,
            [email]
        );

        res.json(result.rows);

    } catch (error) {
        console.error("Get verifications error:", error);
        res.status(500).json({ message: "인증 이력 조회 중 오류가 발생했습니다." });
    } finally {
        client.release();
    }
});

// ✅ 관리자용 주문 현황 조회 API
app.get("/api/all/orders", async (req, res) => {
    const client = await pool.connect();
    try {
        const result = await client.query(`
            SELECT 
                order_id,
                user_name AS buyer,
                total_amount AS transaction_amount,
                payment_status,
                created_at AS approved_at,
                cancelled_at,
                payment_method,
                product_name
            FROM orders
            ORDER BY created_at DESC
            LIMIT 200
        `);

        res.json({
            success: true,
            count: result.rows.length,
            orders: result.rows.map((row, idx) => ({
                no: idx + 1,
                결제수단: row.payment_method || "신용카드",
                거래상태:
                    row.payment_status === "cancelled"
                        ? "전체취소"
                        : row.payment_status === "paid"
                            ? "정상"
                            : "대기중",
                승인일자: row.approved_at,
                취소일자: row.cancelled_at,
                거래금액:
                    row.payment_status === "cancelled"
                        ? -Math.abs(row.transaction_amount)
                        : row.transaction_amount,
                상품명: row.product_name,
                주문번호: row.order_id,
                구매자: row.buyer,
            })),
        });
    } catch (err) {
        console.error("❌ 관리자 주문 조회 실패:", err);
        res.status(500).json({ success: false, message: "서버 오류" });
    } finally {
        client.release();
    }
});
// ✅ 회원 목록 조회 API
app.get("/api/users", async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = (page - 1) * limit;

        // 🔹 특정 도메인 필터 유지 (필요 시 제거)
        const result = await pool.query(
            `
      SELECT id, name, email, created_at
      FROM users
      WHERE email ILIKE '%@kr.kpmg.com'
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
      `,
            [limit, offset]
        );

        const countResult = await pool.query(`
      SELECT COUNT(*) FROM users WHERE email ILIKE '%@kr.kpmg.com'
    `);

        const totalCount = parseInt(countResult.rows[0].count);
        const hasMore = offset + limit < totalCount;

        res.json({
            success: true,
            users: result.rows,
            totalCount,
            hasMore,
        });
    } catch (err) {
        console.error("회원 조회 실패:", err);
        res.status(500).json({ success: false, message: "서버 오류" });
    }
});
// 주문 존재 여부 확인
app.get("/api/payment/order/check/:email", async (req, res) => {
    const { email } = req.params;
    const client = await pool.connect();

    try {
        console.log("🔍 주문 확인 요청:", email);

        // ✅ 1. 테이블 구조에 맞게 컬럼명 정확히
        const query = `
            SELECT id, employee_id, payment_status
            FROM orders
            WHERE user_email = $1
              AND (payment_status IS NULL OR payment_status != 'cancelled')
            LIMIT 1;
        `;

        const result = await client.query(query, [email]);

        console.log("🟢 조회 결과:", result.rows);

        // ✅ 2. 결과 반환
        res.json({
            hasActiveOrder: result.rows.length > 0,
        });
    } catch (err) {
        console.error("❌ Order check error:", err.message);
        console.error("📜 Full stack:", err);
        res.status(500).json({
            message: "주문 확인 실패",
            error: err.message,
        });
    } finally {
        client.release();
    }
});
// ============================================
// 4. 만료된 인증번호 정리 (크론잡용) - 수정 불필요
// ============================================
app.post("/api/admin/cleanup-verifications", verifyToken, requireRole("admin"), async (req, res) => {
    const client = await pool.connect();

    try {
        const result = await client.query(
            `DELETE FROM email_verifications
             WHERE expires_at < NOW()
                OR (verified = true AND created_at < NOW() - INTERVAL '7 days')`
        );

        res.json({
            message: "만료된 인증번호가 정리되었습니다.",
            deletedCount: result.rowCount
        });

    } catch (error) {
        console.error("Cleanup verifications error:", error);
        res.status(500).json({ message: "인증번호 정리 중 오류가 발생했습니다." });
    } finally {
        client.release();
    }
});
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
async function getUserFromCache(email) {
    const cacheKey = `user:${email}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
        return JSON.parse(cached);
    }
    return null;
}

// Redis 캐시에 사용자 저장 (TTL: 1시간)
// Redis 캐시에 사용자 저장 (TTL: 1시간)
async function setUserCache(email, userData) {
    const cacheKey = `user:${email}`;
    await redis.set(cacheKey, JSON.stringify(userData), 'EX', 3600);
}

// Redis 캐시 무효화
async function invalidateUserCache(email) {
    const cacheKey = `user:${email}`;
    await redis.del(cacheKey);
}

// ============================================
// 인증 API
// ============================================
// 홈 노출용
app.get("/api/products/visible", async (req, res) => {
    const client = await pool.connect();
    try {
        const now = new Date();
        const result = await client.query(
            `SELECT * FROM products
             WHERE status = 'active'
             AND is_visible = true
             ORDER BY release_date DESC`,
            []
        );

        console.log("조회된 상품:", result.rows);

        res.json(result.rows);
    } catch (error) {
        console.error("Visible products error:", error);
        res.status(500).json({ message: "상품 목록 조회 실패" });
    } finally {
        client.release();
    }
});
app.get("/api/products/test", async (req, res) => {
    const client = await pool.connect();
    try {
        const now = new Date();
        const result = await client.query(
            `SELECT * FROM products
             WHERE is_visible = false
             ORDER BY release_date DESC`
        );


        console.log("조회된 상품:", result.rows);

        res.json(result.rows);
    } catch (error) {
        console.error("Visible products error:", error);
        res.status(500).json({ message: "상품 목록 조회 실패" });
    } finally {
        client.release();
    }
});
// 1. 일반 로그인 (사번/비밀번호)
// 1️⃣ 비밀번호 초기화 (개발용)
app.post("/api/dev/reset-password", async (req, res) => {
    const client = await pool.connect();

    try {
        const { email, newPassword } = req.body;

        // 입력 검증
        if (!email || !newPassword) {
            return res.status(400).json({
                success: false,
                message: "이메일과 새 비밀번호를 모두 입력해주세요."
            });
        }

        // 사용자 존재 확인
        const userResult = await client.query(
            "SELECT * FROM users WHERE email = $1",
            [email]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "해당 이메일로 등록된 사용자가 없습니다."
            });
        }

        // 비밀번호 해싱
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // DB 업데이트
        const result = await client.query(
            "UPDATE users SET password = $1, updated_at = NOW() WHERE email = $2 RETURNING *",
            [hashedPassword, email]
        );

        // Redis 캐시 무효화
        await invalidateUserCache(email);

        console.log(`✅ [비밀번호 리셋 완료] ${email} → 새 비번: ${newPassword}`);

        return res.json({
            success: true,
            message: "비밀번호가 성공적으로 변경되었습니다.",
            email: result.rows[0].email
        });
    } catch (error) {
        console.error("💥 비밀번호 리셋 오류:", error);
        return res.status(500).json({
            success: false,
            message: "비밀번호 변경 중 서버 오류가 발생했습니다."
        });
    } finally {
        client.release();
    }
});
// 1. 일반 로그인 (이메일/비밀번호) - 수정된 버전
app.post("/api/auth/login", async (req, res) => {
    const client = await pool.connect();

    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ message: "이메일과 비밀번호를 입력해주세요." });
        }

        let user = await getUserFromCache(email);
        if (!user) {
            const result = await client.query('SELECT * FROM users WHERE email = $1', [email]);
            if (result.rows.length === 0) {
                return res.status(404).json({ message: "등록되지 않은 이메일입니다." });
            }
            user = result.rows[0];
            await setUserCache(email, user);
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
                email: user.email,
                employeeId: user.employee_id,
                role: user.role,
                address : user.address,
                address_detail : user.address_detail,
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
        const { employeeId, password, name, email, phone, address, kakaoId, marketingAgreed, address_detail } = req.body;

        if (!name || !email) {
            return res.status(400).json({ message: "필수 정보를 입력해주세요." });
        }

        // ------------------------------------------------------
        // 1️⃣ 이메일 도메인 검사 (@kr.kpmg.com)
        // ------------------------------------------------------
        if (!email.toLowerCase().endsWith("@kr.kpmg.com")) {
            return res.status(400).json({
                message: "회사 이메일(@kr.kpmg.com)로만 가입할 수 있습니다."
            });
        }

        await client.query('BEGIN');

        // ------------------------------------------------------
        // 2️⃣ 블랙리스트 검사
        // ------------------------------------------------------
        const blacklistCheck = await client.query(
            "SELECT status, reason FROM employee_status WHERE email = $1",
            [email]
        );

        if (blacklistCheck.rows.length > 0 && blacklistCheck.rows[0].status === "blacklisted") {
            await client.query("ROLLBACK");
            return res.status(403).json({
                message: "노트북 교체 시 본인이 사용하던 노트북을 구매하신 분은 이번 구매에 참여하실 수 없습니다.<br>\n" +
                    "    더 많은 분들께 공평한 기회를 드리기 위한 조치이오니 이해와 협조 부탁드립니다.<br><br>\n" +
                    "    감사합니다.",
                reason: blacklistCheck.rows[0].reason || null
            });
        }


        // ------------------------------------------------------
        // 4️⃣ 사용자 저장
        // ------------------------------------------------------
        const hashedPassword = password ? await bcrypt.hash(password, 10) : '';

        const insertResult = await client.query(
            `INSERT INTO users (
                employee_id, password, name, email, phone, address, kakao_id, marketing_agreed, role, created_at, address_detail
            )
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'user',NOW(),$9)
             RETURNING *`,
            [
                employeeId,
                hashedPassword,
                name,
                email,
                phone || '',
                address || '',
                kakaoId || null,
                marketingAgreed ?? false,
                address_detail || ''
            ]
        );

        const newUser = insertResult.rows[0];

        if (kakaoId) {
            await redis.set(`kakao:${kakaoId}`, employeeId);
        }

        await setUserCache(newUser.email, newUser);

        await client.query('COMMIT');

        res.status(201).json({
            message: "회원가입이 완료되었습니다.",
            name,
            employeeId
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Signup error:", error);
        res.status(500).json({ message: "회원가입 처리 중 오류가 발생했습니다." });
    } finally {
        client.release();
    }
});

app.get("/api/orders/stats", async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE payment_status = 'pending') AS pending,
                COUNT(*) FILTER (WHERE payment_status = 'paid') AS paid,
                COUNT(*) FILTER (WHERE payment_status = 'cancelled') AS cancelled
            FROM orders
        `);

        res.json(rows[0]);
    } catch (err) {
        console.error("order stats error:", err);
        res.status(500).json({ error: "Failed to load stats" });
    }
});
// 4. 사용자 정보 조회
app.get("/api/user/:email", verifyToken, async (req, res) => {
    const client = await pool.connect();

    try {
        const { email } = req.params;

        const result = await client.query(
            'SELECT * FROM users WHERE email = $1',
            [email]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
        }

        const user = result.rows[0];
        await setUserCache(user.email, user);

        const { password, ...userData } = user;

        res.json(userData);

    } catch (error) {
        console.error("Get user error:", error);
        res.status(500).json({ message: "사용자 정보 조회 오류" });
    } finally {
        client.release();
    }
});



// 5. 사용자 정보 수정
app.put("/api/user/:email", verifyToken, async (req, res) => {
    const client = await pool.connect();

    try {
        const { email: requestEmail } = req.params;   // ← 받은 email
        const { name, email, phone, address, address_detail } = req.body;

        await client.query('BEGIN');

        const result = await client.query(
            `UPDATE users
             SET name = COALESCE($1, name),
                 email = COALESCE($2, email),
                 phone = COALESCE($3, phone),
                 address = COALESCE($4, address),
                 address_detail = COALESCE($5, address_detail),
                 updated_at = NOW()
             WHERE email = $6
                 RETURNING *`,
            [name, email, phone, address, address_detail, requestEmail]
        );

        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                message: "사용자를 찾을 수 없습니다."
            });
        }

        const updatedUser = result.rows[0];

        // ✔ email 기준 캐시 삭제
        await invalidateUserCache(updatedUser.email);

        await client.query('COMMIT');

        res.json({
            message: "사용자 정보가 수정되었습니다.",
            user: updatedUser
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
        const result = await client.query(`
      SELECT 
        p.id,
        p.name,
        p.spec,
        p.price,
        p.stock,
        p.emoji,
        p.description,
        p.image_url,              -- ✅ 대표 이미지
        p.features,
        p.detail_images,
        s.id AS sale_id,
        s.sale_start,
        s.sale_end,
        s.total_stock,
        s.remaining_stock,
        s.status AS sale_status,
        CASE
            WHEN NOW() < s.sale_start THEN 'before'
            WHEN NOW() >= s.sale_start AND NOW() < s.sale_end AND s.remaining_stock > 0 THEN 'during'
            ELSE 'after'
        END AS current_status,
        EXTRACT(EPOCH FROM (s.sale_start - NOW())) AS seconds_until_start
      FROM products p
      JOIN sales s ON p.id = s.product_id
      ORDER BY s.sale_start DESC
      LIMIT 1
    `);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: "판매 정보가 없습니다." });
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
                description: data.description,
                imageUrl: data.image_url,        // ✅ 응답에 포함
                features: data.features,
                detailImages: data.detail_images,
            },
            sale: {
                id: data.sale_id,
                saleStart: data.sale_start,
                saleEnd: data.sale_end,
                totalStock: data.total_stock,
                remainingStock: data.remaining_stock,
                status: data.current_status,
                secondsUntilStart: Math.max(0, data.seconds_until_start),
            },
        });
    } catch (error) {
        console.error("Get current sale error:", error);
        res.status(500).json({ message: "판매 정보 조회 중 오류가 발생했습니다." });
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
app.delete("/api/user/:email", verifyToken, async (req, res) => {
    const client = await pool.connect();

    try {
        const { email } = req.params;

        await client.query('BEGIN');

        // 사용자 조회
        const userCheck = await client.query(
            'SELECT * FROM users WHERE email = $1',
            [email]
        );

        if (userCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
        }

        const user = userCheck.rows[0];

        // DB 삭제
        await client.query(
            'DELETE FROM users WHERE email = $1',
            [email]
        );

        // Redis 캐시 삭제
        await invalidateUserCache(email);

        // 카카오 매핑 삭제
        if (user.kakao_id) {
            await redis.del(`kakao:${user.kakao_id}`);
        }

        await client.query('COMMIT');

        res.json({ message: "회원 탈퇴 완료" });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Delete user error:", error);
        res.status(500).json({ message: "회원 탈퇴 오류" });
    } finally {
        client.release();
    }
});


// 5. 사용자 정보 수정
// app.put("/api/user/:employeeId", verifyToken, async (req, res) => {
//     const client = await pool.connect();
//
//     try {
//         const { employeeId } = req.params;
//         const { name, email, phone, address } = req.body;
//
//         await client.query('BEGIN');
//
//         // DB 업데이트
//         const result = await client.query(
//             `UPDATE users
//              SET name = COALESCE($1, name),
//                  email = COALESCE($2, email),
//                  phone = COALESCE($3, phone),
//                  address = COALESCE($4, address),
//                  updated_at = NOW()
//              WHERE employee_id = $5
//              RETURNING *`,
//             [name, email, phone, address, employeeId]
//         );
//
//         if (result.rows.length === 0) {
//             await client.query('ROLLBACK');
//             return res.status(404).json({
//                 message: "사용자를 찾을 수 없습니다."
//             });
//         }
//
//         // Redis 캐시 무효화
//         await invalidateUserCache(email);
//
//         await client.query('COMMIT');
//
//         // 비밀번호 제외하고 반환
//         const { password, ...userData } = result.rows[0];
//
//         res.json({
//             message: "사용자 정보가 수정되었습니다.",
//             user: userData
//         });
//
//     } catch (error) {
//         await client.query('ROLLBACK');
//         console.error("Update user error:", error);
//         res.status(500).json({
//             message: "사용자 정보 수정 중 오류가 발생했습니다."
//         });
//     } finally {
//         client.release();
//     }
// });

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
// 관리자 상품 등록
app.post("/api/admin/products", verifyToken, requireRole("admin"), async (req, res) => {
    const client = await pool.connect();
    try {
        const {
            name, spec, price, stock, emoji, description,
            features, detailImages, releaseDate
        } = req.body;

        if (!name || !price) {
            return res.status(400).json({ message: "상품명과 가격은 필수입니다." });
        }

        const result = await client.query(
            `INSERT INTO products (
                name, spec, price, stock, emoji, description, features, detail_images, release_date, status, created_at, updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',NOW(),NOW())
             RETURNING *`,
            [name, spec || '', price, stock || 0, emoji || '', description || '', features || [], detailImages || [], releaseDate || null]
        );

        res.status(201).json({ message: "상품이 등록되었습니다.", product: result.rows[0] });
    } catch (error) {
        console.error("Create product error:", error);
        res.status(500).json({ message: "상품 등록 중 오류가 발생했습니다." });
    } finally {
        client.release();
    }
});

// 상품 목록 조회
app.get("/api/admin/products", verifyToken, requireRole("admin"), async (req, res) => {
    const client = await pool.connect();
    try {
        const result = await client.query(`SELECT * FROM products ORDER BY created_at DESC`);
        res.json(result.rows);
    } catch (error) {
        console.error("Get admin products error:", error);
        res.status(500).json({ message: "상품 목록 조회 실패" });
    } finally {
        client.release();
    }
});

// 재고 수정
app.patch("/api/admin/products/:id/stock", verifyToken, requireRole("admin"), async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        const { stock } = req.body;
        await client.query(`UPDATE products SET stock = $1, updated_at = NOW() WHERE id = $2`, [stock, id]);
        res.json({ message: "재고 수정 완료" });
    } catch (error) {
        console.error("Update stock error:", error);
        res.status(500).json({ message: "재고 수정 실패" });
    } finally {
        client.release();
    }
});

// 출시일 설정
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

        if (result.rows.length === 0)
            return res.status(404).json({ message: "상품을 찾을 수 없습니다." });

        res.json({ message: "출시일이 설정되었습니다.", product: result.rows[0] });
    } catch (error) {
        console.error("Set release date error:", error);
        res.status(500).json({ message: "출시일 설정 중 오류" });
    } finally {
        client.release();
    }
});

// 판매 상태 변경 (표시/중지)
app.patch("/api/admin/products/:id/status", verifyToken, requireRole("admin"), async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        const { status } = req.body; // 'active' | 'stopped' | 'scheduled' | 'draft'

        if (!["active", "stopped", "scheduled", "draft"].includes(status)) {
            return res.status(400).json({ message: "유효하지 않은 상태입니다." });
        }

        const result = await client.query(
            `UPDATE products
             SET status = $1, updated_at = NOW()
             WHERE id = $2
             RETURNING *`,
            [status, id]
        );

        if (result.rows.length === 0)
            return res.status(404).json({ message: "상품을 찾을 수 없습니다." });

        res.json({ message: "상태 변경 완료", product: result.rows[0] });
    } catch (error) {
        console.error("Change status error:", error);
        res.status(500).json({ message: "상태 변경 실패" });
    } finally {
        client.release();
    }
});
// PUT /api/admin/products/:id
app.put(
    "/api/admin/products/:id",
    verifyToken,
    requireRole("admin"),
    upload.single("image"), // 👈 프론트에서 보내는 file 필드 이름은 "image"
    async (req, res) => {
        const client = await pool.connect();

        try {
            const { id } = req.params;
            const {
                name,
                price,
                stock,
                description,
                release_date,
                is_visible
            } = req.body;

            // 파일이 있을 경우 URL 생성 (정적 URL로 접근 가능하도록)
            let imageUrl = null;
            if (req.file) {
                // 서버 기준 상대경로
                imageUrl = `https://jimo.world/api/uploads/${req.file.filename}`;
            }

            const query = `
                UPDATE products
                SET 
                    name = COALESCE($1, name),
                    price = COALESCE($2, price),
                    stock = COALESCE($3, stock),
                    description = COALESCE($4, description),
                    release_date = COALESCE($5, release_date),
                    is_visible = COALESCE($6, is_visible),
                    image_url = COALESCE($7, image_url),
                    updated_at = NOW()
                WHERE id = $8
                RETURNING *;
            `;

            const result = await client.query(query, [
                name || null,
                price || null,
                stock || null,
                description || null,
                release_date || null,
                is_visible ? true : false,
                imageUrl, // emoji 대신 썸네일용
                id
            ]);

            if (result.rows.length === 0) {
                return res.status(404).json({ message: "상품을 찾을 수 없습니다." });
            }
// ✅ 캐시 무효화 (상품 전체 목록 캐시 삭제)
            await redis.del("products:all");
            await redis.del(`product:${id}`);
            res.json({
                message: "상품이 수정되었습니다.",
                product: result.rows[0]
            });
        } catch (error) {
            console.error("Update product error:", error);
            res.status(500).json({ message: "상품 수정 중 오류 발생" });
        } finally {
            client.release();
        }
    }
);

// ============================================
// 🧾 주문 관련 API
// ============================================

// 주문 목록 조회 (MyPage용)
// 🔥 경로 수정: 쿼리 파라미터 방식
app.get("/api/myorder", verifyToken, async (req, res) => {
    const client = await pool.connect();
    try {
        // ✅ req.query 사용
        const { email } = req.query;

        if (!email) {
            return res.status(400).json({
                success: false,
                message: "email이 필요합니다."
            });
        }

        console.log("📋 주문 목록 조회:", email);

        const result = await client.query(
            `SELECT
                 order_id,
                 product_name,
                 total_amount AS amount,
                 payment_status AS status,
                 created_at,
                 recipient_name,
                 delivery_phone,
                 delivery_address,
                 delivery_detail_address,
                 delivery_request,
                 tracking_number
             FROM orders
             WHERE user_email = $1
             ORDER BY created_at DESC`,
            [email]
        );

        console.log(`✅ 주문 ${result.rows.length}건 조회 완료`);

        res.json({
            success: true,
            orders: result.rows
        });
    } catch (error) {
        console.error("❌ 주문 목록 조회 실패:", error);
        res.status(500).json({
            success: false,
            message: "주문 목록 조회 실패",
            error: error.message
        });
    } finally {
        client.release();
    }
});

// 주문 상세 조회 (OrderDetailPage용)
app.get("/api/orders/:orderId", verifyToken, async (req, res) => {
    const client = await pool.connect();
    try {
        const { orderId } = req.params;

        const result = await client.query(
            `SELECT 
                order_id,
                product_name,
                total_amount AS amount,
                payment_status AS status,
                payment_method,
                paid_at AS payment_time,
                card_name,
                card_number,
                receipt_url,
                recipient_name,
                delivery_address,
                delivery_detail_address AS delivery_detail,
                delivery_phone AS recipient_phone,
                delivery_status,
                tracking_number,
                created_at
             FROM orders
             WHERE order_id = $1
             LIMIT 1`,
            [orderId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "해당 주문을 찾을 수 없습니다."
            });
        }

        res.json({
            success: true,
            order: result.rows[0]
        });
    } catch (error) {
        console.error("Get order detail error:", error);
        res.status(500).json({ success: false, message: "주문 상세 조회 실패" });
    } finally {
        client.release();
    }
});

// 📍 현재 실행 파일 기준 절대경로 계산
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 📁 uploads 폴더 절대경로 지정
const uploadsPath = path.join(__dirname, "uploads");

// 기존 라인 교체
// app.use("/api/uploads", express.static("uploads"));
app.use("/api/uploads", express.static(uploadsPath));
//
app.get("api/check/product/:id", async (req, res) => {
    const { id } = req.params;

    const { rows } = await pool.query(
        "SELECT * FROM products WHERE id = $1",
        [id]
    );

    if (rows.length === 0) {
        return res.status(404).json({ error: "상품을 찾을 수 없습니다." });
    }

    const product = rows[0];

    // 서버 기준 시간으로 release 체크 (KST 기준 적용)
    const now = new Date();
    const release = new Date(product.release_date);

    product.is_released = now >= release;

    return res.json(product);
});
// 괄호 제거 (현대홈타운(102동) → 현대홈타운)
function clean(addr) {
    return addr.replace(/\s*\(.*?\)/g, "").trim();
}

app.post("/api/update-zipcode", async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT id, delivery_address
            FROM orders
            WHERE delivery_address IS NOT NULL
        `);

        const result = [];

        for (const row of rows) {
            const original = row.delivery_address;
            const cleaned = clean(original);

            const zipcode = await AddressService.getZipcode(cleaned);

            if (zipcode) {
                await pool.query(
                    `UPDATE orders SET zipcode = $1 WHERE id = $2`,
                    [zipcode, row.id]
                );
            }

            result.push({
                id: row.id,
                original,
                cleaned,
                zipcode,
                status: zipcode ? "updated" : "not_found"
            });
        }

        res.json({
            success: true,
            updated: result.filter(r => r.zipcode).length,
            failed: result.filter(r => !r.zipcode).length,
            list: result
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 구매 가능 시간 체크 API (간단 버전)
app.post("/api/check/purchase-time", async (req, res) => {
    const { productId } = req.body;
    const client = await pool.connect();

    try {
        const result = await client.query(
            'SELECT release_date, stock, status FROM products WHERE id = $1',
            [productId]
        );

        if (!result.rows.length) {
            return res.status(404).json({
                success: false,
                error: "상품을 찾을 수 없습니다"
            });
        }

        const product = result.rows[0];
        const now = new Date();
        const releaseDate = new Date(product.release_date);

        // 판매 시작 전이면 차단
        if (releaseDate > now) {
            return res.status(403).json({
                success: false,
                error: "아직 판매가 시작되지 않았습니다",
                release_date: product.release_date,
                time_remaining: Math.floor((releaseDate - now) / 1000)
            });
        }

        // 판매 가능
        res.json({
            success: true,
            message: "구매 가능한 시간입니다"
        });

    } catch (error) {
        console.error("Time check error:", error);
        res.status(500).json({
            success: false,
            error: "시간 확인 중 오류"
        });
    } finally {
        client.release();
    }
});

app.post("/api/payment/queue/cancel", async (req, res) => {
    try {
        const { jobId } = req.body;

        if (!jobId) {
            return res.json({ success: false, message: "jobId 없음" });
        }

        const productId = 1579; // ← 하드코딩
        const listKey = `queue:list:${productId}`;
        const mapKey = `queue:map:${jobId}`;
        const statusKey = `queue:status:${jobId}`;

        // 1️⃣ 리스트에서 해당 jobId 제거
        await redis.lrem(listKey, 1, jobId);

        // 2️⃣ job map 삭제
        await redis.del(mapKey);

        // 3️⃣ status 삭제 (혹시 남아 있을 수 있으므로)
        await redis.del(statusKey);

        return res.json({ success: true });
    } catch (err) {
        console.error("queue cancel error:", err);
        res.status(500).json({ success: false });
    }
});
app.post("/api/product/consume", async (req, res) => {
    const { productId } = req.body;

    const key = `product:${productId}:stock`;
    const stock = await redis.decr(key);

    if (stock < 0) {
        await redis.incr(key);
        return res.json({ success: false });
    }

    // DB도 같이 감소
    await client.query(
        "UPDATE products SET stock = stock - 1 WHERE id = $1",
        [productId]
    );

    return res.json({ success: true });
});
app.post("/api/product/restore", async (req, res) => {
    try {
        const { productId } = req.body;

        if (!productId) {
            return res.json({ success: false, message: "productId 없음" });
        }

        const redisKey = `product:${productId}:stock`;

        // 1️⃣ DB 재고 복원
        const client = await pool.connect();
        await client.query(
            "UPDATE products SET stock = stock + 1 WHERE id = $1",
            [productId]
        );
        client.release();

        // 2️⃣ Redis 캐시 다시 채우기
        const updated = await pool.query(
            "SELECT stock FROM products WHERE id = $1",
            [productId]
        );

        const newStock = updated.rows[0]?.stock;

        await redis.set(redisKey, newStock);

        // 🔥 여기가 핵심 (반드시 await)
        await processNextInQueue(productId);

        // 응답은 끝에
        res.json({ success: true, stock: newStock });

    } catch (err) {
        console.error("restore error:", err);
        res.status(500).json({ success: false });
    }
});

async function processNextInQueue(productId) {
    const listKey = `queue:list:${productId}`;

    const nextJobId = await redis.lpop(listKey);
    if (!nextJobId) return;

    // job 정보를 map에서 조회(사용자 이메일/이름 등)
    const jobInfo = await redis.hgetall(`queue:map:${nextJobId}`);

    // 🔥 중요한 부분: map 삭제
    await redis.del(`queue:map:${nextJobId}`);

    // 🔥 ready 상태 저장 → 프론트에서 status === "ready" 잡음
    await redis.hset(`queue:status:${nextJobId}`, "status", "ready");
    console.log("🔥 processNextInQueue -> READY:", nextJobId, jobInfo);
}
app.get("/api/product/:productId/stock", async (req, res) => {
    const { productId } = req.params;

    try {
        const key = `product:${productId}:stock`;
        const stock = await redis.get(key);

        if (stock === null) {
            return res.json({ success: false, stock: null, message: "재고 정보 없음" });
        }

        return res.json({ success: true, stock: Number(stock) });
    } catch (err) {
        console.error("stock 조회 에러:", err);
        res.status(500).json({ success: false });
    }
});
// ✅ NICEPAY 리턴 처리용 라우트
app.post("/api/payment/results", (req, res) => {
    // 결제 결과를 서버에서 필요 시 로그하거나 DB 기록 가능
    console.log("✅ NICEPAY Return Received:", req.body);

    // NICEPAY는 POST라서 HTML 직접 리턴해야 함
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`
    <!DOCTYPE html>
    <html lang="ko">
    <head>
      <meta charset="UTF-8" />
      <title>결제 처리 중...</title>
      <script>
        // URL 파라미터 유지
        const query = window.location.search || '';
        const redirectUrl = '/#/payment-result' + query;
        window.location.replace(redirectUrl);
      </script>
    </head>
    <body>
      <p>결제 결과를 확인 중입니다. 잠시만 기다려주세요...</p>
    </body>
    </html>
  `);
});
async function syncProductStockToRedis() {
    try {
        const { rows } = await pool.query("SELECT id, stock FROM products");
        for (const p of rows) {
            await redis.set(`product:${p.id}:stock`, p.stock);
        }
        console.log("🔄 Redis 재고 초기화 완료");
    } catch (err) {
        console.error("❌ Redis 재고 초기화 실패:", err);
    }
}
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
    await syncProductStockToRedis();
});
