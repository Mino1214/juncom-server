import pkg from "bullmq";
import IORedis from "ioredis";

const { Queue } = pkg;

// ✅ Redis 연결
const connection = new IORedis({
    host: "127.0.0.1",
    port: 6379,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
});

// ✅ Queue만 export (Worker는 별도 프로세스에서 실행)
export const orderQueue = new Queue("orderInitQueue", { connection });