# Intentionally imperfect: used by COUE's own test suite as a fixture.
FROM python:latest

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

EXPOSE 8000
EXPOSE 5432

CMD ["python", "app.py"]
