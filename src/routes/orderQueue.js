import pkg from "bullmq";
import IORedis from "ioredis";

const { Queue, Worker } = pkg;

// ✅ Redis 연결
const connection = new IORedis({
    host: "127.0.0.1",
    port: 6379,
    maxRetriesPerRequest: null, // bullmq 권장 옵션
    enableReadyCheck: false,
});

console.log("✅ Redis connected");

// ✅ 큐 생성
export const orderQueue = new Queue("orderInitQueue", {
    connection,
});

// ✅ 워커 생성
const worker = new Worker(
    "orderInitQueue",
    async (job) => {
        console.log(`⚙️ Job 시작: ${job.id}`, job.data);
        const { productId, userId } = job.data;

        // 예시 처리 로직
        const orderId = `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        console.log(`✅ 주문 생성 완료: ${orderId}`);
        return { orderId };
    },
    {
        // ✅ 여기 connection 꼭 다시 명시
        connection,
    }
);

// ✅ 워커 이벤트 로그
worker.on("completed", (job, result) => {
    console.log(`✅ Job 완료: ${job.id} → ${result.orderId}`);
});

worker.on("failed", (job, err) => {
    console.error(`💥 Job 실패: ${job.id} (${err.message})`);
});