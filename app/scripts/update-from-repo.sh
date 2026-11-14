#!/bin/bash
# update-from-repo.sh — 确认新版本后的一键服务器更新。
#
# 配合应用内「版本更新」检测（/admin/update）使用：检测到新版本并推送通知后，
# 由人工在服务器上执行本脚本完成部署。流程与历次人工发布一致：
#   预检（磁盘/健康/活动任务）→ 浅克隆仓库 → 校验 VERSION 前进 → docker build
#   → 备份 compose → 切换容器 → 等待 healthy → 运行文件哈希核验
# 任一环节失败：自动恢复 compose 与旧镜像容器，保留回滚材料。
#
# 用法（在 /opt/shn48 下）：
#   bash /opt/shn48/scripts/update-from-repo.sh
# 环境变量：
#   REPO         默认 yu7777777777/shn48-recorder
#   BRANCH       默认 main
#   KEY_FILE     默认 /opt/shn48/config/github-deploy-key（只读 Deploy Key 私钥，600）
#   MIN_FREE_GB  构建前最低可用磁盘，默认 6
#   UPDATE_FORCE 设为 1 时跳过活动任务检查（一般不要用）
set -euo pipefail

REPO="${REPO:-yu7777777777/shn48-recorder}"
BRANCH="${BRANCH:-main}"
KEY_FILE="${KEY_FILE:-/opt/shn48/config/github-deploy-key}"
MIN_FREE_GB="${MIN_FREE_GB:-6}"
TARGET_DIR=/opt/shn48
# 优先 compose v2 插件；旧服务器只有 v1（docker-compose）时回退。
if docker compose version >/dev/null 2>&1; then COMPOSE_BIN="docker compose"; else COMPOSE_BIN="docker-compose"; fi
COMPOSE="$COMPOSE_BIN -f $TARGET_DIR/docker-compose.yml -f $TARGET_DIR/docker-compose.public.yml"

say() { echo "[update] $*"; }
die() { echo "[update] ✗ $*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "请以 root 运行"
# Deploy Key（私有仓库必需）可选：公开仓库可直接匿名 HTTPS 克隆。
if [ -f "$KEY_FILE" ]; then
  chmod 600 "$KEY_FILE"
  CLONE_URL="git@github.com:$REPO.git"
  CLONE_ENV=(GIT_SSH_COMMAND="ssh -i $KEY_FILE -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" GIT_TERMINAL_PROMPT=0)
  CLONE_MODE="Deploy Key 只读"
else
  CLONE_URL="https://github.com/$REPO.git"
  CLONE_ENV=(GIT_TERMINAL_PROMPT=0)
  CLONE_MODE="匿名 HTTPS（公开仓库）"
fi

WORK="$(mktemp -d /opt/shn48/build-repo-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

free_gb() { df -BG --output=avail / | tail -1 | tr -dc '0-9'; }

say "1/7 预检"
OLD_VER="$(docker exec shn48-recorder cat /app/VERSION 2>/dev/null)" || die "当前容器不可用"
HEALTH="$(docker inspect shn48-recorder --format '{{.State.Health.Status}}')" || die "无法读取容器状态"
[ "$HEALTH" = "healthy" ] || die "当前容器不健康（$HEALTH），先人工排障再更新"
if [ "${UPDATE_FORCE:-0}" != "1" ]; then
  # 回放审计的完整解码校验（ffmpeg -f null）只读且可中断（状态持久化，下次复查重跑），
  # 不算占用；录制/上传类 ffmpeg 与 biliup 才是必须等待的活动任务。
  BUSY="$(docker exec shn48-recorder sh -c 'ps -eo args | grep -E "ffmpeg|biliup" | grep -v grep | grep -v -- "-f null" || true')"
  if [ -n "$BUSY" ]; then
    echo "$BUSY" | head -3 | sed 's/^/[update]   /'
    die "检测到录制/上传任务正在运行，等待其结束后再更新（确认放弃任务后 UPDATE_FORCE=1）"
  fi
  say "  无录制/上传任务（回放校验类只读任务不算占用）"
fi
FREE="$(free_gb)"
if [ "$FREE" -lt "$MIN_FREE_GB" ]; then
  say "  可用 ${FREE}GB 不足，先清理 Docker 构建缓存"
  docker builder prune -f >/dev/null 2>&1 || true
  FREE="$(free_gb)"
  [ "$FREE" -ge "$MIN_FREE_GB" ] || die "可用 ${FREE}GB 仍低于 ${MIN_FREE_GB}GB，先手动清理磁盘"
fi
say "  当前版本 $OLD_VER，可用磁盘 ${FREE}GB"

say "2/7 拉取仓库（浅克隆，$CLONE_MODE）"
env "${CLONE_ENV[@]}" \
  git clone --depth 1 --branch "$BRANCH" "$CLONE_URL" "$WORK/repo" 2>&1 \
  | sed 's/^/[update]   /' || die "克隆失败：检查仓库可见性 / Deploy Key 权限 / 网络"

say "3/7 校验版本前进"
NEW_VER="$(tr -d '[:space:]' < "$WORK/repo/app/VERSION")"
[ "$NEW_VER" != "$OLD_VER" ] || die "仓库版本 $NEW_VER 与运行版本相同，无需更新"
SORTED="$(printf '%s\n%s\n' "$NEW_VER" "$OLD_VER" | sort -V | head -1)"
[ "$SORTED" = "$OLD_VER" ] || die "仓库版本 $NEW_VER 不高于运行版本 $OLD_VER，拒绝降级"
[ -f "$WORK/repo/app/RUNTIME-SHA256SUMS" ] || die "仓库缺少 RUNTIME-SHA256SUMS，发布流程未完成"
say "  $OLD_VER -> $NEW_VER"

# 源码完整性：克隆树必须与发布清单逐字节一致。清单中 git 忽略的构建产物
# （client/dist、.tools 等）不在克隆里，按存在性过滤后核验 git 跟踪的源码。
say "  核验克隆源码完整性（SHA256SUMS，跳过不入库的构建产物）"
cd "$WORK/repo/app"
: > "$WORK/src-check.sums"
while IFS= read -r line; do
  h="${line%%  *}"; p="${line#*  }"
  [ -f "$p" ] && printf '%s  %s\n' "$h" "$p" >> "$WORK/src-check.sums"
done < SHA256SUMS
SRC_TOTAL="$(wc -l < "$WORK/src-check.sums")"
SRC_BAD="$(sha256sum -c "$WORK/src-check.sums" 2>/dev/null | grep -cv ': OK$' || true)"
[ "$SRC_BAD" = "0" ] || { sha256sum -c "$WORK/src-check.sums" 2>/dev/null | grep -v ': OK$' | head -10; die "克隆源码与发布清单存在 $SRC_BAD 处不一致"; }
say "  $SRC_TOTAL 项源码哈希一致"

say "4/7 构建镜像 shn48-shn48:$NEW_VER（约 10-20 分钟）"
# Docker Hub 在部分网络不可达：优先使用本地已有基础镜像，其次走 ECR 公共镜像源兜底。
if ! docker image inspect node:20-bookworm-slim >/dev/null 2>&1; then
  docker pull node:20-bookworm-slim >/dev/null 2>&1 || {
    say "  Docker Hub 不可达，改用 public.ecr.aws 镜像源拉取基础镜像"
    docker pull public.ecr.aws/docker/library/node:20-bookworm-slim >/dev/null
    docker tag public.ecr.aws/docker/library/node:20-bookworm-slim node:20-bookworm-slim
  }
fi
docker build -t "shn48-shn48:$NEW_VER" \
  --build-arg DEBIAN_MIRROR="${DEBIAN_MIRROR:-http://mirrors.aliyun.com/debian}" \
  --build-arg NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}" \
  --build-arg PIP_INDEX_URL="${PIP_INDEX_URL:-https://mirrors.aliyun.com/pypi/simple/}" \
  "$WORK/repo/app" 2>&1 | tail -5 || die "镜像构建失败（已保留缓存，可修复后重试）"

# 运行时预期态从「构建出的镜像」导出：vite 产物跨环境非逐字节确定，本地构建的
# dist 哈希不能作为服务器构建产物的核验基准；镜像本身才是刚审计过的预期。
say "  从镜像导出运行时预期清单"
docker run --rm --entrypoint /bin/sh "shn48-shn48:$NEW_VER" -c \
  'cd /app && find VERSION client/dist server -type f -not -path "*/node_modules/*" | sort | xargs sha256sum' \
  > "$WORK/expected-rt.sums"
[ -s "$WORK/expected-rt.sums" ] || die "镜像运行清单导出为空"

say "5/7 备份并更新 compose（镜像 tag -> $NEW_VER）"
STAMP="$(date +%Y%m%d-%H%M%S)"
cp "$TARGET_DIR/docker-compose.yml" "$TARGET_DIR/docker-compose.yml.before-$STAMP"
cp "$WORK/repo/app/docker-compose.yml" "$TARGET_DIR/docker-compose.yml"
cp "$WORK/repo/app/docker-compose.public.yml" "$TARGET_DIR/docker-compose.public.yml"
cp "$WORK/repo/app/docker-compose.local.yml" "$TARGET_DIR/docker-compose.local.yml" 2>/dev/null || true
COMPOSE_BACKUP="$TARGET_DIR/docker-compose.yml.before-$STAMP"

rollback() {
  say "切换后核验失败，回滚到 $OLD_VER"
  cp "$COMPOSE_BACKUP" "$TARGET_DIR/docker-compose.yml"
  cd "$TARGET_DIR"
  $COMPOSE up -d 2>&1 | tail -2 || true
  sleep 10
  say "回滚完成，当前版本：$(docker exec shn48-recorder cat /app/VERSION 2>/dev/null || echo 未知)"
}
trap 'rm -rf "$WORK"; rollback' EXIT

say "6/7 切换容器并等待 healthy"
cd "$TARGET_DIR"
$COMPOSE up -d --no-build 2>&1 | tail -3
for i in $(seq 1 36); do
  S="$(docker inspect shn48-recorder --format '{{.State.Health.Status}}' 2>/dev/null || echo starting)"
  [ "$S" = "healthy" ] && break
  [ "$S" = "unhealthy" ] && { docker logs --tail 15 shn48-recorder 2>&1 | sed 's/^/[update]   /'; die "容器 unhealthy"; }
  sleep 5
done
[ "${S:-}" = "healthy" ] || die "健康检查超时（最后状态：${S:-未知}）"
HB="$(curl -s -m 10 http://127.0.0.1:3000/api/public/health)"
echo "$HB" | grep -q "$NEW_VER" || die "健康接口版本异常：$HB"
say "  healthy，健康接口返回 $NEW_VER"

say "7/7 运行文件哈希核验"
docker exec -i shn48-recorder sh -c 'cat > /tmp/update-rt.sums' < "$WORK/expected-rt.sums"
RT_CHECK="$(docker exec shn48-recorder sh -c 'cd /app && sha256sum -c /tmp/update-rt.sums 2>&1' || true)"
RT_TOTAL="$(echo "$RT_CHECK" | grep -c ': OK$' || true)"
RT_BAD="$(echo "$RT_CHECK" | grep -v ': OK$' | head -10 || true)"
docker exec shn48-recorder rm -f /tmp/update-rt.sums
[ -z "$RT_BAD" ] || { echo "$RT_BAD" | sed 's/^/[update]   /'; die "运行文件哈希核验存在不一致"; }
say "  $RT_TOTAL 个运行文件哈希全部一致"

# 构建缓存是小磁盘服务器的主要累积源：核验通过后立即回收，保证下一次更新仍有余量。
docker builder prune -f >/dev/null 2>&1 || true
say "  构建缓存已回收，当前可用 $(free_gb)GB"

trap - EXIT
rm -rf "$WORK"
say "✓ 更新完成：$OLD_VER -> $NEW_VER"
say "以下为已停止容器，确认无回滚用途后再手动清理："
docker ps -a --format '{{.Names}}  {{.Status}}' | grep -v 'Up ' || echo "  （无）"
say "回滚材料：镜像 shn48-shn48:$OLD_VER 与 $COMPOSE_BACKUP"
