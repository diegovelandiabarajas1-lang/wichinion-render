# Wichinion (motor propio de Wichi) para el plan gratuito de Render (512 MB, 0,1 CPU).
# Mismo trabajo que el OpenCode de Cowork: API compatible, skills, ALU y guardián anti-sueño.
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
RUN apk add --no-cache git perl curl bash \
 && addgroup -S motor && adduser -S motor -G motor \
 && mkdir -p /data /workspace && chown -R motor:motor /data /workspace
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY --chown=motor:motor workspace/ /workspace/
# Guardián: mantiene despierto a Render mientras un agente trabaja (aunque nadie envíe mensajes).
COPY mantener-despierto.sh arranque.sh /
RUN chmod 0755 /mantener-despierto.sh /arranque.sh /workspace/herramientas/*.sh
# La contraseña la genera Render (OPENCODE_SERVER_PASSWORD, que Wichinion también entiende).
# La clave de NVIDIA NO va aquí: la guarda cada persona desde la app (queda en /data, cifrada).
ENV NODE_ENV=production \
    MOTOR_PORT=10000 \
    MOTOR_HOST=0.0.0.0 \
    MOTOR_DATA=/data \
    MOTOR_WORKDIR=/workspace \
    MOTOR_NIM_BASE=https://integrate.api.nvidia.com/v1 \
    MOTOR_CORS=https://diegovelandiabarajas1-lang.github.io \
    MOTOR_PERMISSIONS=ask
USER motor
EXPOSE 10000
ENTRYPOINT ["/arranque.sh"]
