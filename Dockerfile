# Keep the Python ABI identical in builder and runtime. uv.lock pins Python deps;
# Cargo.lock pins the optional native accelerators. No tenant data is baked in.
FROM python:3.13.5-slim-bookworm AS rust-builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl build-essential \
    && rm -rf /var/lib/apt/lists/*
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain 1.85.1
ENV PATH="/root/.cargo/bin:${PATH}"
RUN pip install --no-cache-dir maturin==1.9.6
WORKDIR /build
COPY rust/ ./rust/
RUN mkdir -p /wheels \
    && for d in rust/*/; do (cd "$d" && maturin build --locked --release --out /wheels) || exit 1; done

FROM python:3.13.5-slim-bookworm AS runtime
# Set to 1 to support arbitrary native .kicad_pcb uploads with system pcbnew.
# The default slim image supports hash-verified KiCad sidecars and boardviews.
ARG INSTALL_KICAD=0
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils ghostscript nodejs \
    && if [ "$INSTALL_KICAD" = 1 ]; then apt-get install -y --no-install-recommends kicad; fi \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir uv==0.13.7
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never \
    PATH="/app/.venv/bin:${PATH}"
WORKDIR /app
COPY pyproject.toml uv.lock .python-version README.md ./
RUN uv sync --locked --no-dev --no-install-project --no-cache
COPY api/ ./api/
RUN uv sync --locked --no-dev --no-editable --no-cache
COPY --from=rust-builder /wheels/ /wheels/
RUN uv pip install --python /app/.venv/bin/python --no-cache /wheels/*.whl && rm -rf /wheels
COPY web/ ./web/
COPY board_assets/ ./board_assets/
COPY scripts/ ./scripts/
# Mount memory/ and, only in Managed Agents mode, managed_ids.json at runtime.
EXPOSE 8000
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]
