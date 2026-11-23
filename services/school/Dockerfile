# School connectors: Quercus (API token), Piazza (login), UofT mail via Gmail IMAP (read-only), public
# course sites. Holds those credentials (env_file secrets/school.env) and nothing else.
FROM python:3.14-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /opt/school
COPY requirements.txt .
RUN pip install --no-cache-dir --only-binary=:all: --no-deps -r requirements.txt
COPY school ./school
COPY tests ./tests
RUN python -m unittest discover -s tests -v && rm -rf tests
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin school \
    && mkdir -p /var/lib/school && chown school:school /var/lib/school
USER school
EXPOSE 8095
CMD ["python", "-m", "school"]
