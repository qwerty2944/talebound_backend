import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export interface JwtPayload {
  sub: string; // userId
  email: string;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: "7d" });
}

export function verifyToken(token: string): JwtPayload {
  const decoded = jwt.verify(token, env.JWT_SECRET);
  if (typeof decoded === "string" || !decoded.sub) {
    throw new Error("잘못된 토큰");
  }
  return { sub: decoded.sub, email: (decoded as JwtPayload).email };
}
