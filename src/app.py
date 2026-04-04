import streamlit as st
import logging
import traceback
import glob
import json
import os
import pandas as pd
# from ui_components import render_header, render_metrics, render_knowledge_graph # Moved to main to prevent startup crash
import urllib.parse
import base64
import urllib.parse
import base64
# from streamlit_pdf_viewer import pdf_viewer # Moved inside render_pdf_viewer to prevent startup crash

st.set_page_config(layout="wide", page_title="QCI Central Finite Curve", page_icon="∞")

# Configure logging to file
logging.basicConfig(
    filename='app_debug.log', 
    level=logging.ERROR, 
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

# --- PATHS (absolute so they work on Streamlit Cloud regardless of cwd) ---
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROCESSED_DIR = os.path.join(BASE_DIR, "data", "processed")

# --- DATA LOADING ---
@st.cache_data
def load_data():
    files = glob.glob(os.path.join(PROCESSED_DIR, "*.json"))
    data = []
    for f in files:
        try:
            with open(f, "r", encoding='utf-8') as infile:
                doc = json.load(infile)
                # Flatten meta
                row = doc.get("meta", {})
                row["filename"] = doc.get("doc_id")
                # Ensure fields exist
                row["ministry"] = row.get("ministry", "Unknown")
                row["date"] = row.get("date", "Unknown")
                row["value_inr"] = float(row.get("value_inr", 0)) if row.get("value_inr") else 0.0
                
                # Prioritize specific project subject over generic domain
                row["project_subject"] = row.get("project_subject", "")
                if not row["project_subject"] or row["project_subject"] == "Unknown Subject":
                     row["display_subject"] = row.get("domains", [""])[0] if row.get("domains") else "Unknown"
                else:
                     row["display_subject"] = row["project_subject"]
                
                # Backward compatibility for UI
                row["subject"] = row["display_subject"]

                # Add content fields
                content = doc.get("content", {})
                row["full_text"] = content.get("full_text", "")
                # deliverables lives in meta (set by RunPulse ingestion)
                row["deliverables"] = row.get("deliverables", content.get("deliverables", ""))
                
                data.append(row)
        except Exception as e:
            logging.error(f"Error loading {f}: {e}")
            # print(f"Error loading {f}: {e}")
            
    return pd.DataFrame(data)

def get_snippet(text, query, context=50):
    if not query:
        return text[:200]
    
    idx = text.lower().find(query.lower())
    if idx == -1:
        return text[:200]
        
    start = max(0, idx - context)
    end = min(len(text), idx + len(query) + context)
    return "..." + text[start:end].replace("\n", " ") + "..."

def normalize_ministry(name):
    # Normalize variants of Ministry name
    name_lower = name.lower()
    if "personnel" in name_lower and "pensions" in name_lower:
        return "Ministry of Personnel, PG & Pensions"
    return name

def shorten_label(filename):
    # Convert "5th Work Order_SCDPM PMU_DARPG..." -> "5th SCDPM PMU"
    try:
        parts = filename.split('_')
        if len(parts) >= 2:
            # part[0] is usually "5th Work Order"
            number_part = parts[0].split('Work')[0].strip() # "5th"
            
            # part[1] is usually "SCDPM PMU"
            pmu_part = parts[1].replace("PMU", "").strip() # "SCDPM"
            
            if "PMU" not in pmu_part:
               pmu_part += " PMU"
               
            return f"{number_part} {pmu_part}"
    except Exception:
        pass
    return filename[:15] + "..."

# --- MAIN APP ---
def render_pdf_viewer():
    file_id = st.session_state.get("active_pdf_id")
    if not file_id:
        st.error("No file selected.")
        if st.button("Back to Dashboard"):
            st.session_state["view_mode"] = "dashboard"
            st.rerun()
        return

    # Header
    c1, c2 = st.columns([1, 5])
    with c1:
        if st.button("⬅️ Back to Dashboard"):
            st.session_state["view_mode"] = "dashboard"
            st.session_state["active_pdf_id"] = None
            st.rerun()
    with c2:
        st.subheader(f"📄 Viewing: {shorten_label(file_id)}")

    # PDF Display
    # STRATEGY: Streamlit PDF Viewer Component
    # This reads the binary file locally (guaranteed to exists since we can download it)
    # and renders it natively in the app using PDF.js logic, bypassing Chrome Security blocks on iframes.
    
    file_path = os.path.join(BASE_DIR, "static", "pdfs", f"{file_id}.pdf")
    
    try:
        # We pass the file path directly if it's local
        from streamlit_pdf_viewer import pdf_viewer
        pdf_viewer(file_path, width=1000, height=1000)
        
        # Download Button (Keep as fallback)
        with open(file_path, "rb") as f:
            st.download_button(
                label="⬇️ Download PDF",
                data=f,
                file_name=f"{file_id}.pdf",
                mime="application/pdf"
            )
        
    except FileNotFoundError:
        st.error(f"File not found on server: {file_path}")
    except Exception as e:
        st.error(f"Error loading PDF: {e}")

def render_dashboard():
    # --- SEARCH ENGINE ---
    df = load_data()
    
    if df.empty:
        st.warning("No data found in data/processed. Please run ingestion first.")
        return

    search_query = st.text_input("🔍 Search Database (Ministry, Amount, Scope/Deliverables...)", "")
    
    if search_query:
        # Search across relevant columns including Deliverables
        mask = (
            df["ministry"].str.contains(search_query, case=False, na=False) | 
            df["filename"].str.contains(search_query, case=False, na=False) |
            df["full_text"].str.contains(search_query, case=False, na=False) |
            df["display_subject"].str.contains(search_query, case=False, na=False)
        )
        search_results = df[mask]
        
        st.subheader(f"Search Results ({len(search_results)})")
        
        for _, row in search_results.iterrows():
            with st.expander(f"📄 {row['display_subject']} ({row['date']})"):
                c1, c2 = st.columns([3, 1])
                with c1:
                    # If query matches deliverables, prioritize showing that snippet
                    if row['deliverables'] and search_query.lower() in row['deliverables'].lower():
                        st.markdown("**Matched in Deliverables:**")
                        snippet = get_snippet(row['deliverables'], search_query)
                        st.info(f"> {snippet}")
                    else:
                        snippet = get_snippet(row['full_text'], search_query)
                        st.markdown(f"**Match Context:**\n> {snippet}")
                    
                    st.text(f"File: {row['filename']}")
                    
                    # Viewer Button
                    if st.button(f"📄 Open PDF", key=f"btn_{row['filename']}"):
                        st.session_state["active_pdf_id"] = row['filename']
                        st.session_state["view_mode"] = "viewer"
                        st.rerun()

                    if row['deliverables']:
                        with st.expander("View extracted Scope/Deliverables"):
                            st.write(row['deliverables'])

                with c2:
                    st.metric("Value", f"₹{row['value_inr']:,.0f}")
                    st.caption(f"Ministry: {row['ministry']}")
                    
        st.divider()
        st.caption("Detailed Dashboard below...")

    # --- SIDEBAR FILTERS ---
    st.sidebar.title("Filters")
    # Apply normalization to Dataframe for consistent filtering
    df["ministry_norm"] = df["ministry"].apply(normalize_ministry)
    
    selected_ministry = st.sidebar.multiselect("Ministry", df["ministry_norm"].unique())
    
    # Cost Filter
    min_cost = int(df["value_inr"].min())
    max_cost = int(df["value_inr"].max())
    cost_range = st.sidebar.slider("Total Project Cost (₹)", min_cost, max_cost, (min_cost, max_cost)) # Slider logic
    
    # Filter Logic
    filtered_df = df.copy()
    if selected_ministry:
        filtered_df = filtered_df[filtered_df["ministry_norm"].isin(selected_ministry)]
    
    # Filter by Cost
    filtered_df = filtered_df[
        (filtered_df["value_inr"] >= cost_range[0]) & 
        (filtered_df["value_inr"] <= cost_range[1])
    ]
        
    # --- METRICS ---
    total_val = filtered_df["value_inr"].sum()
    top_min = filtered_df["ministry_norm"].mode()[0] if not filtered_df.empty else "N/A"
    from ui_components import render_metrics # Lazy import
    render_metrics(len(filtered_df), total_val, top_min)
    
    st.divider()
    
    # --- KNOWLEDGE GRAPH CONSTRUCTION ---
    c1, c2 = st.columns([2, 1])
    
    with c1:
        st.subheader("🕸️ Institutional Knowledge Graph")
        
        nodes = []
        edges = []
        
        # Central Hub
        nodes.append({"id": "QCI", "label": "Quality Council of India", "type": "Hub", "image": "https://upload.wikimedia.org/wikipedia/en/thumb/8/8f/Quality_Council_of_India_Logo.svg/1200px-Quality_Council_of_India_Logo.svg.png"})
        
        for _, row in filtered_df.iterrows():
            # File Node
            file_id = row["filename"]
            short_label = shorten_label(file_id)
            # Pass full Subject in tooltip via 'title' which we handle in ui_components
            
            nodes.append({"id": file_id, "label": short_label, "full_label": f"{short_label}\n{row['project_subject']}", "type": "File"})
            
            # Ministry Node (Normalized)
            min_id = row["ministry_norm"]
            nodes.append({"id": min_id, "label": min_id, "type": "Ministry"})
            
            # Edges
            # QCI -> Ministry (Vendor relationship implied or Project Owner)
            edges.append({"source": "QCI", "target": min_id, "relation": "Partners"})
            
            # Ministry -> File
            edges.append({"source": min_id, "target": file_id, "relation": "Issued"})
        
        # Render
        # 1. Initialize Session State for Collapsing
        if "collapsed_nodes" not in st.session_state:
            st.session_state["collapsed_nodes"] = set()
            
        # 2. Filter Nodes/Edges based on Collapsed State
        visible_nodes = []
        visible_edges = []
        
        # Check if Hub is collapsed
        hub_collapsed = "QCI" in st.session_state["collapsed_nodes"]
        
        for n in nodes:
            # Always show Hub
            if n["id"] == "QCI":
                visible_nodes.append(n)
                continue
                
            # If Hub is collapsed, hide everything else
            if hub_collapsed:
                continue
            
            # Identify Ministry Nodes
            if n["type"] == "Ministry":
                visible_nodes.append(n)
                continue
            
            # For File Nodes, check if their parent Ministry is collapsed
            # We need to find the parent ministry for this file
            # In our data construction, we know the parent from the edges or the row data
            # Let's verify by checking the edge list for this target
            parent_min = None
            for e in edges:
                if e["target"] == n["id"]:
                    parent_min = e["source"]
                    break
            
            if parent_min and parent_min in st.session_state["collapsed_nodes"]:
                continue # Parent ministry is collapsed, hide file
                
            visible_nodes.append(n)
            
        # Filter Edges: Both source and target must be visible
        visible_node_ids = set(n["id"] for n in visible_nodes)
        for e in edges:
            if e["source"] in visible_node_ids and e["target"] in visible_node_ids:
                visible_edges.append(e)

        from ui_components import render_knowledge_graph # Lazy import
        selected_node_id = render_knowledge_graph(visible_nodes, visible_edges)
        
        # Handle Graph Selection (PDF Opening & Collapsing)
        if selected_node_id:
             # Check if it is a file node (files usually have "Work Order" or specific ID patterns, ministries are names)
             # Simplest check: Matches a filename in our DF
             if selected_node_id in filtered_df["filename"].values:
                 st.session_state["active_pdf_id"] = selected_node_id
                 st.session_state["view_mode"] = "viewer"
                 st.rerun()
             
             # Check if it is QCI or Ministry (Collapsing Logic)
             elif selected_node_id == "QCI" or selected_node_id in filtered_df["ministry_norm"].values:
                 # Toggle Collapse
                 if selected_node_id in st.session_state["collapsed_nodes"]:
                     st.session_state["collapsed_nodes"].remove(selected_node_id)
                     st.toast(f"Expanded: {selected_node_id}")
                 else:
                     st.session_state["collapsed_nodes"].add(selected_node_id)
                     st.toast(f"Collapsed: {selected_node_id}")
                 
                 # Force Rerun to update graph
                 st.rerun()

    with c2:
        st.subheader("📄 Document Details")
        # Update selection to allow searching logic to influence this? 
        # For now, independent.
        selected_file = st.selectbox("Select Document", filtered_df["filename"])
        
        if selected_file:
            file_data = filtered_df[filtered_df["filename"] == selected_file].iloc[0]
            st.info(f"**Subject**: {file_data['subject']}")
            st.write(f"**Ministry**: {file_data['ministry_norm']}")
            st.write(f"**Date**: {file_data['date']}")
            st.write(f"**Value**: ₹{file_data['value_inr']:,.2f}")
            
            if st.button("🚀 Open PDF in Viewer", key="details_open_pdf"):
                st.session_state["active_pdf_id"] = selected_file
                st.session_state["view_mode"] = "viewer"
                st.rerun()

            # Show Raw JSON Content (Partial)
            with open(os.path.join(PROCESSED_DIR, f"{selected_file}.json"), "r") as f:
                full_json = json.load(f)
                st.text_area("Extracted Content", full_json["content"]["full_text"][:500] + "...", height=200)

def main():
    try:
        from ui_components import render_header, render_metrics, render_knowledge_graph
        render_header()
    except ImportError as e:
        st.error(f"⚠️ Critical Dependency Error: {e}")
        st.error("This usually means a library listed in requirements.txt failed to install on the Cloud.")
        st.stop()
        
    # Initialize View Mode
    if "view_mode" not in st.session_state:
        st.session_state["view_mode"] = "dashboard"
    
    if st.session_state["view_mode"] == "viewer":
        render_pdf_viewer()
    else:
        render_dashboard()

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        logging.error("Fatal Application Error", exc_info=True)
        st.error("🚨 An unexpected error occurred. Please capture this screen and share it with support.")
        st.code(traceback.format_exc())
