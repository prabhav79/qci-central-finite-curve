import os
import streamlit as st
from github import Github

def push_to_github(doc_id: str, extension: str, raw_content_bytes: bytes, json_content_string: str):
    """
    Push both the raw uploaded file and the processed JSON to GitHub.
    This ensures persistence on Streamlit Cloud and triggers an auto-refresh.
    """
    token = os.getenv("GITHUB_TOKEN")
    if not token and hasattr(st, "secrets"):
        token = st.secrets.get("GITHUB_TOKEN")
        
    if not token or token == "ghp_your_token_here":
        st.warning("⚠️ GitHub Token not found in secrets. Files will only persist for this session.")
        return False
        
    repo_name = "prabhav79/qci-central-finite-curve"
    g = Github(token)
    
    try:
        repo = g.get_repo(repo_name)
    except Exception as e:
        st.error(f"Failed to connect to GitHub repo. Make sure the token is valid and has repo scope. Error: {e}")
        return False

    raw_path = f"Work Orders/{doc_id}{extension}"
    json_path = f"data/processed/{doc_id}.json"
    commit_message = f"Upload: Ad-hoc ingestion of {doc_id} via Streamlit Dashboard"
    
    success = True
    
    # 1. Commit Raw File
    try:
        repo.create_file(raw_path, commit_message, raw_content_bytes, branch="main")
        st.toast(f"✅ Raw file saved to {raw_path}")
    except Exception as e:
        st.error(f"Error saving raw file to GitHub: {e}")
        success = False

    # 2. Commit JSON File
    try:
        repo.create_file(json_path, commit_message, json_content_string, branch="main")
        st.toast(f"✅ Extracted metadata saved to {json_path}")
    except Exception as e:
        st.error(f"Error saving JSON to GitHub: {e}")
        success = False
        
    if success:
        st.success("🎉 Upload permanently saved to GitHub! The dashboard will auto-refresh in about 60 seconds as Streamlit Cloud redeploys.")
        
    return success
