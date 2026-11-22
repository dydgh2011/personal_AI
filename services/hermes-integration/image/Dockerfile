# Hermes with the document-reading library for the personal_ai_document tool.
#
# The official image is used as it is; the only addition is pypdf (pure Python, no
# native code) in its own directory, outside Hermes's venv. The plugin adds that
# directory to the end of sys.path, so it can never replace one of Hermes's packages.
# DOCX files are read with the standard library (zipfile + XML), no extra package.
#
# Update Hermes: docker compose @F build --pull hermes; docker compose @F up -d hermes

FROM python:3.14-slim AS deps
RUN pip install --no-cache-dir --only-binary=:all: --target /deps pypdf==6.21.4

FROM nousresearch/hermes-agent:stable
COPY --from=deps /deps /opt/personal-ai/pydeps
