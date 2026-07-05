import fs from "fs";
import dotenv from "dotenv";

// Colyseus Cloud는 대시보드 환경변수를 .env.cloud 로 심어준다. 로컬은 .env 사용.
// (이미 설정된 값은 덮어쓰지 않음)
dotenv.config({ path: ".env.cloud" });
dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    // 배포 환경 진단: cwd와 존재하는 .env* 파일 목록을 에러에 포함
    let envFiles = "?";
    try {
      envFiles = fs.readdirSync(process.cwd()).filter((f) => f.startsWith(".env")).join(",") || "(없음)";
    } catch { /* noop */ }
    throw new Error(
      `환경변수 ${name}이(가) 설정되지 않았습니다. cwd=${process.cwd()} NODE_ENV=${process.env.NODE_ENV} envFiles=${envFiles}`
    );
  }
  return value;
}

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  JWT_SECRET: required("JWT_SECRET"),
  PORT: Number(process.env.PORT || 2567),
  // 콤마로 여러 origin 허용 (예: "https://mug-web.vercel.app,http://localhost:3000")
  CORS_ORIGIN: (process.env.CORS_ORIGIN || "http://localhost:3000").split(",").map((s) => s.trim()),
};
