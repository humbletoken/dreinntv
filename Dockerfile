# «Полутон» — кинозал для своих: сайт и Telegram-бот в одном контейнере.
#
# Сборка:
#   docker build -t poluton .
# Запуск (настройки берутся из .env, внутрь образа он не копируется):
#   docker run -d --name poluton --init --restart unless-stopped \
#     --env-file .env -p 3000:3000 -v poluton-data:/data poluton
#
# Фильмы, музыка, база SQLite и cookies.txt лежат в томе /data и переживают пересборку.
# Перед контейнером нужен HTTPS (Telegram открывает Mini App только по https): Caddy, nginx или Traefik.

FROM node:22-bookworm-slim

# ffmpeg/ffprobe — обработка видео и звука
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp — официальный самостоятельный бинарник (со всеми зависимостями внутри).
# Лежит в каталоге пользователя node, поэтому сервер сам обновляет его командой `yt-dlp -U`
# при каждом запуске и раз в 6 часов: старый yt-dlp — главная причина ошибок загрузки.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) file=yt-dlp_linux ;; \
      arm64) file=yt-dlp_linux_aarch64 ;; \
      *) echo "неподдерживаемая архитектура: $arch" >&2; exit 1 ;; \
    esac; \
    mkdir -p /opt/yt-dlp /data; \
    curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$file" -o /opt/yt-dlp/yt-dlp; \
    chmod 755 /opt/yt-dlp/yt-dlp; \
    chown -R node:node /opt/yt-dlp /data; \
    /opt/yt-dlp/yt-dlp --version

ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    PORT=3000 \
    DATA_DIR=/data \
    YTDLP_PATH=/opt/yt-dlp/yt-dlp \
    PATH=/opt/yt-dlp:$PATH

WORKDIR /app
COPY bot.js index.html ./

USER node
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/boot').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "bot.js"]
