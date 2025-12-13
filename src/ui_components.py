import streamlit as st
from streamlit_agraph import agraph, Node, Edge, Config

def render_header():
    st.markdown("""
        <style>
        .main-header {
            font-size: 3.5rem;
            font-weight: 700;
            background: -webkit-linear-gradient(45deg, #4285F4, #34A853);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            text-align: center;
            margin-bottom: 0.5rem;
        }
        .sub-header {
            font-size: 1.2rem;
            color: #A0A0A0;
            text-align: center;
            margin-bottom: 2rem;
        }
        .metric-card {
            background-color: #262730;
            padding: 20px;
            border-radius: 10px;
            border-left: 5px solid #4285F4;
            box-shadow: 0 4px 6px rgba(0,0,0,0.3);
            text-align: center;
            height: 160px;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
        }
        .metric-value {
            font-size: 2rem;
            font-weight: bold;
            color: #FFFFFF;
        }
        .metric-label {
            font-size: 0.9rem;
            color: #A0A0A0;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-top: 5px;
        }
        </style>
        <div>
            <h1 class="main-header">QCI Central Finite Curve</h1>
            <p class="sub-header">Indexing the Multiverse of Institutional Knowledge</p>
        </div>
    """, unsafe_allow_html=True)

def render_metrics(total_files, total_value, top_ministry):
    c1, c2, c3 = st.columns(3)
    with c1:
        st.markdown(f"""
            <div class="metric-card">
                <div class="metric-value">{total_files}</div>
                <div class="metric-label">Processed Work Orders</div>
            </div>
        """, unsafe_allow_html=True)
    with c2:
        val_cr = total_value / 10000000 
        st.markdown(f"""
            <div class="metric-card">
                <div class="metric-value">₹{val_cr:.2f} Cr</div>
                <div class="metric-label">Total Value</div>
            </div>
        """, unsafe_allow_html=True)
    with c3:
        st.markdown(f"""
            <div class="metric-card">
                <div class="metric-value" style="font-size: 1.5rem;">{top_ministry}</div>
                <div class="metric-label">Top Ministry</div>
            </div>
        """, unsafe_allow_html=True)

def render_knowledge_graph(nodes_data, edges_data):
    # Convert data to agraph format
    nodes = []
    edges = []
    
    # Track added nodes to avoid duplicates
    added_nodes = set()

    for n in nodes_data:
        if n['id'] not in added_nodes:
            # Use 'title' for tooltip (full detail) - passed from app.py as full_label or title
            tooltip = n.get('full_label', n['label'])
            
            nodes.append(Node(
                id=n['id'], 
                label=n['label'], 
                title=tooltip, # tooltip
                size=60 if n['type'] == 'Hub' else 15, 
                shape="circularImage" if n.get('image') else "dot",
                image=n.get('image', ''),
                color="#34A853" if n['type'] == 'File' else "#4285F4",
                # Font settings with stroke for universal contrast
                font={'size': 14, 'color': 'white', 'strokeWidth': 2, 'strokeColor': '#000000'},
                # DISABLE NAVIGATION: Explicitly set link/path to empty/None to prevent agraph from trying to open the ID as a URL
                link="",
                path=""
            ))
            added_nodes.add(n['id'])

    for e in edges_data:
        edges.append(Edge(
            source=e['source'], 
            target=e['target'], 
            # label=e.get('relation', ''), # REMOVED EDGE LABEL per user request
            color="#BDC1C6"
        ))

    config = Config(
        width=None, 
        height=600, 
        directed=True,
        physics=True,
        # ForceAtlas2Based is often better for decluttering large graphs
        physicsOptions={
            'solver': 'forceAtlas2Based',
            'forceAtlas2Based': {'theta': 0.5, 'gravitationalConstant': -50, 'centralGravity': 0.01, 'springLength': 100, 'springConstant': 0.08},
            'minVelocity': 0.75,
            'stabilization': {'enabled': True, 'iterations': 200}
        },
        hierarchical=False,
        nodeHighlightBehavior=True, 
        highlightColor="#F7A7A6",
        collapsible=False # We handle collapsing server-side now
    )

    return agraph(nodes=nodes, edges=edges, config=config)
