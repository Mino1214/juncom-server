// redis.js
import Redis from "ioredis";

const redis = new Redis({
    host: "127.0.0.1", // 같은 서버라면 localhost
    port: 6379,        // 기본 포트
});

redis.on("connect", () => console.log("✅ Redis connected"));
redis.on("error", (err) => console.error("❌ Redis error:", err));

export default redis;