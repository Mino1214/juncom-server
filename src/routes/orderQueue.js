import pkg from "bullmq";
import IORedis from "ioredis";
import pg from "pg";

const { Queue, Worker } = pkg;
const { Pool } = pg;

// ✅ Redis 연결
const connection = new IORedis({
    host: "127.0.0.1",
    port: 6379,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
});

// ✅ PostgreSQL 연결
const pool = new Pool({
    host: process.env.DB_HOST || "jimo.world",
    port: 5432,
    database: process.env.DB_NAME || "postgres",
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "1107",
    ssl: process.env.DB_HOST !== "localhost" ? { rejectUnauthorized: false } : false,
});

export const orderQueue = new Queue("orderInitQueue", { connection });

// ✅ 주문 생성 워커
const worker = new Worker(
    "orderInitQueue",
    async (job) => {
        // 🔥 자동취소 job은 건너뛰기
        if (job.name === "autoCancelOrder") return;

        const client = await pool.connect();
        try {
            const { productId, employeeId, userName, userEmail, userPhone } = job.data;

            // 🔥 필수 데이터 검증
            if (!productId) {
                throw new Error("productId가 필요합니다.");
            }
            if (!userEmail) {
                throw new Error("userEmail이 필요합니다.");
            }

            // 🔥 안전한 기본값 처리
            const safeEmployeeId = employeeId && employeeId.trim() !== "" ? employeeId : "GUEST";
            const safeUserName = userName && userName.trim() !== "" ? userName : "미입력";
            const safeUserPhone = userPhone && userPhone.trim() !== "" ? userPhone : null;

            console.log(`🧾 주문 생성 요청: productId=${productId}, employeeId=${safeEmployeeId}, email=${userEmail}`);

            await client.query("BEGIN");

            // 1️⃣ 재고 확인 및 잠금
            const { rows } = await client.query(
                "SELECT id, name, price, stock FROM products WHERE id = $1 FOR UPDATE",
                [productId]
            );
            const product = rows[0];

            if (!product) throw new Error("상품을 찾을 수 없습니다.");
            if (product.stock <= 0) throw new Error("품절되었습니다.");

            // 2️⃣ 재고 차감
            await client.query("UPDATE products SET stock = stock - 1 WHERE id = $1", [productId]);

            // 3️⃣ 주문 ID 생성
            const orderId = `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

            // 4️⃣ 주문 생성
            await client.query(
                `INSERT INTO orders (
                    order_id,
                    employee_id,
                    user_name,
                    user_email,
                    user_phone,
                    product_id,
                    product_name,
                    product_price,
                    payment_status,
                    total_amount,
                    created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $8, NOW())`,
                [
                    orderId,
                    safeEmployeeId,
                    safeUserName,
                    userEmail,
                    safeUserPhone,
                    product.id,
                    product.name,
                    product.price,
                ]
            );

            await client.query("COMMIT");

            console.log(`✅ 주문 생성 완료: ${orderId} (사용자: ${userEmail}, employeeId: ${safeEmployeeId})`);

            // 5️⃣ 자동취소 Job 예약 (1분 뒤)
            await orderQueue.add(
                "autoCancelOrder",
                {
                    orderId,
                    productId: product.id,
                    userEmail
                },
                { delay: 1 * 60 * 1000 }
            );

            return { orderId };
        } catch (err) {
            await client.query("ROLLBACK");
            console.error("❌ 주문 생성 실패:", err.message);
            throw err;
        } finally {
            client.release();
        }
    },
    { connection }
);

// ✅ 자동 취소 워커
const cancelWorker = new Worker(
    "orderInitQueue",
    async (job) => {
        // 🔥 autoCancelOrder job만 처리
        if (job.name !== "autoCancelOrder") return;

        const { orderId, productId, userEmail } = job.data;
        const client = await pool.connect();

        try {
            console.log(`⏳ 자동취소 검사 시작: ${orderId} (사용자: ${userEmail || "알 수 없음"})`);

            await client.query("BEGIN");

            // 1️⃣ 주문 상태 확인 (잠금)
            const { rows } = await client.query(
                "SELECT product_id, payment_status FROM orders WHERE order_id = $1 FOR UPDATE",
                [orderId]
            );

            if (rows.length === 0) {
                console.warn(`⚠️ 주문 ${orderId} 없음`);
                await client.query("ROLLBACK");
                return;
            }

            const { product_id, payment_status } = rows[0];

            // 2️⃣ 이미 결제된 주문인지 확인
            if (payment_status !== "pending") {
                console.log(`✅ 주문 ${orderId} 이미 처리됨 (${payment_status})`);
                await client.query("ROLLBACK");
                return;
            }

            // 3️⃣ 주문 취소
            await client.query(
                "UPDATE orders SET payment_status = 'canceled', canceled_at = NOW() WHERE order_id = $1",
                [orderId]
            );

            // 4️⃣ 재고 원복
            await client.query(
                "UPDATE products SET stock = stock + 1 WHERE id = $1",
                [product_id]
            );

            await client.query("COMMIT");

            console.log(`🚫 주문 ${orderId} 자동취소 + 재고 원복 완료 (사용자: ${userEmail || "알 수 없음"})`);
        } catch (err) {
            await client.query("ROLLBACK");
            console.error(`💥 자동취소 처리 오류(${orderId}):`, err.message);
        } finally {
            client.release();
        }
    },
    { connection }
);

// ✅ 로그
worker.on("completed", (job, result) => {
    if (job.name !== "autoCancelOrder") {
        console.log(`✅ 주문 생성 Job 완료: ${job.id} → ${result?.orderId}`);
    }
});
worker.on("failed", (job, err) => {
    console.error(`💥 Job 실패: ${job.id} - ${err.message}`);
});

cancelWorker.on("completed", (job) => {
    console.log(`🕒 자동취소 Job 완료: ${job.id}`);
});
cancelWorker.on("failed", (job, err) => {
    console.error(`💥 자동취소 Job 실패: ${job.id} - ${err.message}`);
});