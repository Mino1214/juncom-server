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

// ✅ 워커: 순서가 되면 여기서 실행됨
const worker = new Worker(
    "orderInitQueue",
    async (job) => {
        const client = await pool.connect();
        try {
            const { productId, employeeId, userName, userEmail, userPhone } = job.data;

            console.log(`🧾 주문 생성 요청: productId=${productId}, employeeId=${employeeId}`);

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
                    employeeId || "SYSTEM",
                    userName || "미입력",
                    userEmail || null,
                    userPhone || null,
                    product.id,
                    product.name,
                    product.price,
                ]
            );

            await client.query("COMMIT");

            console.log(`✅ 주문 생성 완료: ${orderId}`);
            return { orderId };
        } catch (err) {
            await client.query("ROLLBACK");
            console.error("❌ 주문 생성 실패:", err);
            throw err;
        } finally {
            client.release();
        }
    },
    { connection }
);

// ✅ 로그
worker.on("completed", (job, result) => {
    console.log(`✅ Job 완료: ${job.id} → ${result.orderId}`);
});
worker.on("failed", (job, err) => {
    console.error(`💥 Job 실패: ${job.id} (${err.message})`);
});

// import pkg from "bullmq";
// import IORedis from "ioredis";
// import pg from "pg";
//
// const { Queue, Worker } = pkg;
// const { Pool } = pg;
//
// // ✅ Redis 연결
// const connection = new IORedis({
//     host: "127.0.0.1",
//     port: 6379,
//     maxRetriesPerRequest: null,
//     enableReadyCheck: false,
// });
//
// // ✅ PostgreSQL 연결
// const pool = new Pool({
//     host: process.env.DB_HOST || "jimo.world",
//     port: 5432,
//     database: process.env.DB_NAME || "postgres",
//     user: process.env.DB_USER || "postgres",
//     password: process.env.DB_PASSWORD || "1107",
//     ssl: process.env.DB_HOST !== "localhost" ? { rejectUnauthorized: false } : false,
// });
//
// // ✅ 주문 큐
// export const orderQueue = new Queue("orderInitQueue", { connection });
//
// // ✅ 주문 생성 워커
// const worker = new Worker(
//     "orderInitQueue",
//     async (job) => {
//         const client = await pool.connect();
//         try {
//             const { productId, employeeId, userName, userEmail, userPhone } = job.data;
//
//             console.log(`🧾 주문 생성 요청: productId=${productId}, employeeId=${employeeId}`);
//             await client.query("BEGIN");
//
//             // 1️⃣ 재고 확인 및 잠금
//             const { rows } = await client.query(
//                 "SELECT id, name, price, stock FROM products WHERE id = $1 FOR UPDATE",
//                 [productId]
//             );
//             const product = rows[0];
//             if (!product) throw new Error("상품을 찾을 수 없습니다.");
//             if (product.stock <= 0) throw new Error("품절되었습니다.");
//
//             // 2️⃣ 재고 차감
//             await client.query("UPDATE products SET stock = stock - 1 WHERE id = $1", [productId]);
//
//             // 3️⃣ 주문 ID 생성
//             const orderId = `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
//
//             // 4️⃣ 주문 생성
//             await client.query(
//                 `INSERT INTO orders (
//                     order_id,
//                     employee_id,
//                     user_name,
//                     user_email,
//                     user_phone,
//                     product_id,
//                     product_name,
//                     product_price,
//                     payment_status,
//                     total_amount,
//                     created_at
//                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $8, NOW())`,
//                 [
//                     orderId,
//                     employeeId || "SYSTEM",
//                     userName || "미입력",
//                     userEmail || null,
//                     userPhone || null,
//                     product.id,
//                     product.name,
//                     product.price,
//                 ]
//             );
//
//             await client.query("COMMIT");
//             console.log(`✅ 주문 생성 완료: ${orderId}`);
//
//             // ✅ NEW: 자동 취소 job 등록 (5분 뒤 실행)
//             await orderQueue.add(
//                 "autoCancelOrder",
//                 { orderId },
//                 { delay: 5 * 60 * 1000 } // 5분 = 300000ms
//             );
//
//             return { orderId };
//         } catch (err) {
//             await client.query("ROLLBACK");
//             console.error("❌ 주문 생성 실패:", err);
//             throw err;
//         } finally {
//             client.release();
//         }
//     },
//     { connection }
// );
//
// // ✅ NEW: 자동 취소 워커
// const cancelWorker = new Worker(
//     "orderInitQueue",
//     async (job) => {
//         if (job.name !== "autoCancelOrder") return;
//         const { orderId } = job.data;
//         const client = await pool.connect();
//
//         try {
//             console.log(`⏳ 자동취소 검사 시작: ${orderId}`);
//
//             const { rows } = await client.query(
//                 "SELECT payment_status FROM orders WHERE order_id = $1",
//                 [orderId]
//             );
//
//             if (rows.length === 0) {
//                 console.warn(`⚠️ 주문 ${orderId} 없음`);
//                 return;
//             }
//
//             const status = rows[0].payment_status;
//
//             if (status === "pending") {
//                 await client.query(
//                     "UPDATE orders SET payment_status = 'canceled', canceled_at = NOW() WHERE order_id = $1",
//                     [orderId]
//                 );
//                 console.log(`🚫 주문 ${orderId} 결제 미완료로 자동취소됨`);
//             } else {
//                 console.log(`✅ 주문 ${orderId} 이미 결제 완료 (상태: ${status})`);
//             }
//         } catch (err) {
//             console.error(`💥 자동취소 처리 오류(${orderId}):`, err.message);
//         } finally {
//             client.release();
//         }
//     },
//     { connection }
// );
//
// // ✅ 로그
// worker.on("completed", (job, result) => {
//     console.log(`✅ Job 완료: ${job.id} → ${result.orderId}`);
// });
// worker.on("failed", (job, err) => {
//     console.error(`💥 Job 실패: ${job.id} (${err.message})`);
// });
//
// cancelWorker.on("completed", (job) => {
//     console.log(`🕒 자동취소 Job 완료: ${job.id}`);
// });
// cancelWorker.on("failed", (job, err) => {
//     console.error(`💥 자동취소 Job 실패: ${job.id} (${err.message})`);
// });