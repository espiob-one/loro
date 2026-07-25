FROM nginx:1.27-alpine

LABEL org.opencontainers.image.title="English Lab A1-B2"
LABEL org.opencontainers.image.description="Curso interactivo de ingles A1-B2, 100% offline"

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY web/ /usr/share/nginx/html/

EXPOSE 80

# 127.0.0.1 y no localhost: dentro del contenedor localhost resuelve primero a
# ::1, y nginx con "listen 80" sólo escucha en IPv4 -> connection refused.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
