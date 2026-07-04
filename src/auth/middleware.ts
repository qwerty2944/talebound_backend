import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "./jwt.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      userEmail?: string;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "인증이 필요합니다" });
    return;
  }

  try {
    const payload = verifyToken(header.slice(7));
    req.userId = payload.sub;
    req.userEmail = payload.email;
    next();
  } catch {
    res.status(401).json({ error: "유효하지 않은 토큰입니다" });
  }
}
