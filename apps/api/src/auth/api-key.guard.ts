import { timingSafeEqual } from "node:crypto";
import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type { Request } from "express";
import { ENV } from "../tokens.js";
import type { ApiEnv } from "../env.js";

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(@Inject(ENV) private readonly env: ApiEnv) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization ?? "";
    const [scheme, token] = header.split(" ");

    if (scheme !== "Bearer" || !token || !this.safeEqual(token, this.env.AGENT_API_KEY)) {
      throw new UnauthorizedException("Invalid or missing API key");
    }
    return true;
  }

  private safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }
}
