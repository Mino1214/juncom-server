import pkg from "bullmq"; // ✅ CommonJS 모듈 default import
import IORedis from "ioredis";
import pg from "pg";

const { Worker, QueueScheduler } = pkg; // ✅ 구조 분해
const { Pool } = pg;

const connection = new IORedis({ host: "127.0.0.1", port: 6379 });

const pool = new Pool({
    host: process.env.DB_HOST || "jimo.world",
    port: 5432,
    database: process.env.DB_NAME || "postgres",
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "1107",
    ssl: process.env.DB_HOST !== "localhost" ? { rejectUnauthorized: false } : false,
});

// BullMQ는 scheduler가 필수 (지연/재시도 관리)
const scheduler = new QueueScheduler("orderInitQueue", { connection });
await scheduler.waitUntilReady();

// 실제 큐 작업 처리
const worker = new Worker(
    "orderInitQueue",
    async (job) => {
        const client = await pool.connect();
        try {
            const { productId, userId } = job.data;
            await client.query("BEGIN");

            const { rows } = await client.query(
                "SELECT id, name, price, stock FROM products WHERE id = $1 FOR UPDATE",
                [productId]
            );

            const product = rows[0];
            if (!product || product.stock <= 0) throw new Error("품절되었습니다.");

            await client.query("UPDATE products SET stock = stock - 1 WHERE id = $1", [productId]);

            const orderId = `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
            await client.query(
                `INSERT INTO orders (order_id, user_id, product_id, product_name, product_price, payment_status)
         VALUES ($1, $2, $3, $4, $5, 'pending')`,
                [orderId, userId, product.id, product.name, product.price]
            );

            await client.query("COMMIT");
            console.log(`[QUEUE] ${orderId} 처리 완료`);
            return { orderId };
        } catch (err) {
            await client.query("ROLLBACK");
            console.error("❌ 큐 처리 실패:", err);
            throw err;
        } finally {
            client.release();
        }
    },
    { connection }
);

worker.on("completed", (job, result) => {
    console.log(`✅ Job 완료: ${job.id} → ${result.orderId}`);
});

worker.on("failed", (job, err) => {
    console.error(`💥 Job 실패: ${job.id} (${err.message})`);
});

export const orderQueue = new Queue("orderInitQueue", { connection });