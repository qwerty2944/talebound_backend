-- 2026-07-05 정산 멱등성 영속화: consumed_jtis 테이블 (원격 DB에 적용 완료된 사본)
-- battle usedJti / dungeon clearedRunJti 인메모리 Map을 대체/보완.
-- 재시작·PM2 다중 인스턴스에서도 재플레이 이중지급을 막는다.
-- 접근은 백엔드 service role pool 전용 — RLS enable + 정책 없음(anon/authenticated 차단).

create table if not exists consumed_jtis (
  jti text primary key,
  expires_at timestamptz not null
);

create index if not exists consumed_jtis_expires_at_idx on consumed_jtis (expires_at);

alter table consumed_jtis enable row level security;
