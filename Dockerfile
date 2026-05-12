# syntax=docker/dockerfile:1

FROM node:22-alpine AS frontend-build
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY index.html vite.config.js ./
COPY src ./src

ARG VITE_API_BASE_URL=
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

FROM python:3.12-slim AS runtime
WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    FRONTEND_DIST_PATH=/app/dist \
    DATABASE_PATH=/app/runtime/app.db \
    ANNOTATION_STORAGE_PATH=/app/runtime/annotations \
    TEST_DATASET_PATH=/app/runtime/test \
    MNIST_STORAGE_PATH=/app/backend/data/mnist \
    ADMIN_UI_BASE_URL=http://localhost:8000 \
    CORS_ORIGINS=http://localhost:8000

COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir --timeout 120 --retries 10 \
    -i https://pypi.tuna.tsinghua.edu.cn/simple \
    -r backend/requirements.txt

COPY backend ./backend
COPY --from=frontend-build /app/dist ./dist

RUN mkdir -p /app/runtime/annotations /app/runtime/test

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3).read()"

CMD ["python", "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
