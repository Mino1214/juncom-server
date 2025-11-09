import pkg from "bullmq";
import IORedis from "ioredis";

const { Queue, Worker } = pkg;

// Redis 연결
const connection = new IORedis({
    host: "127.0.0.1",
    port: 6379,
});

console.log("✅ Redis connected");

// 큐 정의 (한 번만!)
export const orderQueue = new Queue("orderInitQueue", { connection });

// 워커 정의
const worker = new Worker(
    "orderInitQueue",
    async (job) => {
        console.log(`⚙️ 작업 시작: ${job.id}`, job.data);

        const { productId, userId } = job.data;
        const orderId = `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        console.log(`✅ 주문 생성 완료: ${orderId}`);
        return { orderId };
    },
    { connection }
);

// 이벤트 로그
worker.on("completed", (job, result) => {
    console.log(`✅ Job 완료: ${job.id} → ${result.orderId}`);
});

worker.on("failed", (job, err) => {
    console.error(`💥 Job 실패: ${job.id} (${err.message})`);
});