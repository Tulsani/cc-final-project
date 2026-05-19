from fastapi import FastAPI
from pydantic import BaseModel

import vertexai
from vertexai.language_models import TextEmbeddingModel

import chromadb
from chromadb.config import Settings

# ===================================================
# Initialize Vertex AI
# ===================================================

vertexai.init(
    project="ekrs-rag-system",
    location="us-central1"
)

# ===================================================
# Load Vertex AI Embedding Model
# ===================================================

embedding_model = TextEmbeddingModel.from_pretrained(
    "text-embedding-005"
)

# ===================================================
# Initialize ChromaDB Vector Store
# ===================================================

client = chromadb.Client(
    Settings(anonymized_telemetry=False)
)

collection = client.get_or_create_collection(
    name="enterprise_documents"
)

# ===================================================
# Sample Enterprise Document
# ===================================================

sample_document = """
Enterprise legal contract regarding financial agreements
between multiple international clients.
"""

# ===================================================
# Generate Embedding for Document
# ===================================================

sample_embedding = embedding_model.get_embeddings(
    [sample_document]
)[0].values

# ===================================================
# Store Document + Embedding in Vector DB
# ===================================================

existing_docs = collection.get()

if "doc1" not in existing_docs["ids"]:

    collection.add(
        documents=[sample_document],
        ids=["doc1"],
        embeddings=[sample_embedding]
    )

# ===================================================
# Initialize FastAPI
# ===================================================

app = FastAPI()

# ===================================================
# Request Schema
# ===================================================

class QueryRequest(BaseModel):
    query: str

# ===================================================
# RAG Query Endpoint
# ===================================================

@app.post("/query")
def query_rag(request: QueryRequest):

    query_text = request.query

    # -----------------------------------------------
    # Generate Embedding for User Query
    # -----------------------------------------------

    query_embedding = embedding_model.get_embeddings(
        [query_text]
    )[0].values

    # -----------------------------------------------
    # Semantic Vector Search
    # -----------------------------------------------

    results = collection.query(
        query_embeddings=[query_embedding],
        n_results=1
    )

    # -----------------------------------------------
    # Retrieve Best Matching Document
    # -----------------------------------------------

    retrieved_text = results["documents"][0][0]

    # -----------------------------------------------
    # Return NLP-style Semantic Response
    # -----------------------------------------------

    return {
        "query": query_text,
        "answer": retrieved_text
    }

# ===================================================
# Run Local FastAPI Server
# ===================================================

if __name__ == "__main__":

    import uvicorn

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8000
    )
