# Bulk importer for the knowledge store (run on demand, see compose.knowledge-operator.yaml).
# Standard library + pypdf (pure Python). Tests run in the build.
FROM python:3.14-slim
RUN pip install --no-cache-dir --only-binary=:all: pypdf==6.21.4 \
 && useradd --uid 10000 --no-create-home --shell /usr/sbin/nologin importer
WORKDIR /app
COPY kbimport ./kbimport
COPY tests ./tests
RUN python -B -m unittest discover -s tests && rm -rf tests
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 10000:10000
ENTRYPOINT ["python", "-m", "kbimport"]
CMD ["scan"]
