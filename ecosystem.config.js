export default {
    apps: [
        {
            name: "juncom-redis",         // PM2 프로세스 이름
            script: "./src/app.js",        // 실행 파일
            instances: "max",              // CPU 코어 개수만큼 실행
            exec_mode: "cluster",          // 클러스터 모드 (병렬 분산)
            watch: false,                  // 코드 변경 자동 재시작 (개발용만 true)
            env: {
                NODE_ENV: "production",
                PORT: 5000,
            },
        },
        {
            name: "juncom-worker",         // 🔥 워커 전용 프로세스
            script: "./src/worker.js",     // 워커 파일
            instances: 1,                  // 🔥 워커는 1개만 실행 (중복 방지)
            exec_mode: "fork",             // 🔥 fork 모드 (cluster 아님)
            watch: false,
            env: {
                NODE_ENV: "production",
            },
        },
    ],
};