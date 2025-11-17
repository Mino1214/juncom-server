import pkg from "bullmq";
import IORedis from "ioredis";
import pg from "pg";

const { Worker } = pkg;
const { Pool } = pg;

// Redis 연결
const connection = new IORedis({
    host: "127.0.0.1",
    port: 6379,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
});

// PostgreSQL 연결
const pool = new Pool({
    host: process.env.DB_HOST || "jimo.world",
    port: 5432,
    database: process.env.DB_NAME || "postgres",
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "1107",
    ssl: process.env.DB_HOST !== "localhost" ? { rejectUnauthorized: false } : false,
});

// ----------------------------------------------------
// 🔥 주문 생성 워커
// ----------------------------------------------------
const orderWorker = new Worker(
    "orderInitQueue",
    async (job) => {
        if (job.name === "autoCancelOrder") return;

        const client = await pool.connect();
        try {
            const { productId, employeeId, userName, userEmail, userPhone } = job.data;

            if (!productId) throw new Error("productId가 필요합니다.");
            if (!userEmail) throw new Error("userEmail이 필요합니다.");

            const safeEmployeeId = employeeId && employeeId.trim() !== "" ? employeeId : "GUEST";
            const safeUserName = userName && userName.trim() !== "" ? userName : "미입력";
            const safeUserPhone = userPhone && userPhone.trim() !== "" ? userPhone : null;

            console.log(`🧾 주문 생성 요청: p=${productId}, id=${safeEmployeeId}, email=${userEmail}`);

            await client.query("BEGIN");

            const { rows } = await client.query(
                "SELECT id, name, price, stock FROM products WHERE id = $1 FOR UPDATE",
                [productId]
            );

            const product = rows[0];
            if (!product) throw new Error("상품을 찾을 수 없습니다.");
            if (product.stock <= 0) throw new Error("품절되었습니다.");

            // 재고 차감 (조건부 업데이트로 경쟁 조건 방지)
            const updateResult = await client.query(
                "UPDATE products SET stock = stock - 1 WHERE id = $1 AND stock > 0",
                [productId]
            );

            // 실제로 재고가 차감되었는지 확인 (affected rows 체크)
            if (updateResult.rowCount === 0) {
                throw new Error("품절되었습니다. (동시 구매로 인해 재고 부족)");
            }

            const orderId = `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

            await client.query(
                `INSERT INTO orders (
                    order_id, employee_id, user_name, user_email,
                    user_phone, product_id, product_name, product_price,
                    payment_status, total_amount, created_at
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$8,NOW())`,
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

            console.log(`✅ 주문 생성 완료: ${orderId}`);

            // 자동취소 예약
            await job.queue.add(
                "autoCancelOrder",
                { orderId, productId: product.id, userEmail },
                { delay: 60_000 }
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
    {
        connection,
        concurrency: 1  // 🔥 동시에 하나의 작업만 처리하여 경쟁 조건 방지
    }
);

// ----------------------------------------------------
// 🔥 자동 취소 워커
// ----------------------------------------------------
const cancelWorker = new Worker(
    "orderInitQueue",
    async (job) => {
        if (job.name !== "autoCancelOrder") return;

        const { orderId, productId, userEmail } = job.data;
        const client = await pool.connect();

        try {
            console.log(`⏳ 자동취소 검사: ${orderId}`);

            await client.query("BEGIN");

            const { rows } = await client.query(
                "SELECT product_id, payment_status FROM orders WHERE order_id = $1 FOR UPDATE",
                [orderId]
            );

            if (!rows.length) {
                await client.query("ROLLBACK");
                return;
            }

            const { product_id, payment_status } = rows[0];

            if (payment_status !== "pending") {
                await client.query("ROLLBACK");
                return;
            }

            await client.query(
                "UPDATE orders SET payment_status='canceled', canceled_at=NOW() WHERE order_id=$1",
                [orderId]
            );

            await client.query(
                "UPDATE products SET stock = stock + 1 WHERE id = $1",
                [product_id]
            );

            await client.query("COMMIT");

            console.log(`🚫 자동취소 완료 + 재고 복원: ${orderId}`);
        } catch (err) {
            await client.query("ROLLBACK");
            console.error(`💥 자동취소 오류(${orderId}):`, err.message);
        } finally {
            client.release();
        }
    },
    {
        connection,
        concurrency: 1  // 🔥 동시에 하나의 작업만 처리하여 경쟁 조건 방지
    }
);

console.log("🔥 Worker started: orderInitQueue");