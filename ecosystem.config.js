export default {
    apps: [
        {
            name: "roomi-server",         // PM2 프로세스 이름
            script: "./app.js",           // 실행 파일
            instances: "max",             // CPU 코어 개수만큼 실행 (10코어면 10개)
            exec_mode: "cluster",         // 클러스터 모드 (병렬 분산)
            watch: false,                 // 코드 변경 자동 재시작 (개발용만 true)
            env: {
                NODE_ENV: "production",
                PORT: 3000,
            },
        },
    ],
};