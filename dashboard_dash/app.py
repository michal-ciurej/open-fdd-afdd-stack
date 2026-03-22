from __future__ import annotations

import json
from pathlib import Path

import dash
from dash import Dash, Input, Output, State, dcc, html
import dash_bootstrap_components as dbc
import dash_draggable
import plotly.graph_objects as go

BASE_DIR = Path(__file__).resolve().parent
DATA_PATH = BASE_DIR.parent / 'dashboard' / 'progress.json'


def load_data() -> dict:
    if not DATA_PATH.exists():
        return {
            'summary': {'status': 'missing', 'focus': ['progress.json not found']},
            'timeseries': {
                'labels': [],
                'api_calls_total': [],
                'openfdd_local_api_calls': [],
                'raw_bacnet_rpc_requests': [],
                'context_notes_pushed': [],
                'context_window_relapse': [],
                'notes': 'No data file present.'
            },
            'timeline': [],
            'recent_commits': [],
            'recent_logs': [],
            'key_findings': [],
            'next_steps': [],
            'github': {'issue': {}, 'pr_watch': {}}
        }
    return json.loads(DATA_PATH.read_text(encoding='utf-8'))


def series_figure(data: dict) -> go.Figure:
    ts = data['timeseries']
    fig = go.Figure()
    labels = ts['labels']
    fig.add_trace(go.Scatter(x=labels, y=ts['api_calls_total'], mode='lines+markers', name='API calls total'))
    fig.add_trace(go.Scatter(x=labels, y=ts['openfdd_local_api_calls'], mode='lines+markers', name='Open-FDD local API'))
    fig.add_trace(go.Scatter(x=labels, y=ts['raw_bacnet_rpc_requests'], mode='lines+markers', name='Raw BACnet RPC'))
    fig.add_trace(go.Scatter(x=labels, y=ts['context_notes_pushed'], mode='lines+markers', name='Context notes pushed'))
    fig.add_trace(go.Scatter(x=labels, y=ts['context_window_relapse'], mode='lines+markers', name='Context window relapse'))
    fig.update_layout(
        template='plotly_dark',
        paper_bgcolor='#121933',
        plot_bgcolor='#121933',
        margin=dict(l=30, r=20, t=20, b=30),
        legend=dict(orientation='h', yanchor='bottom', y=1.02, x=0),
        font=dict(color='#e8eefc')
    )
    return fig


def list_block(title: str, items: list[str]) -> dbc.Card:
    return dbc.Card([
        dbc.CardHeader(html.H4(title, className='mb-0')),
        dbc.CardBody(html.Ul([html.Li(x) for x in items], className='mb-0'))
    ], className='h-100 shadow-sm bg-dark text-light border-secondary')


def card_component(card_id: str, title: str, body) -> html.Div:
    return html.Div(
        dbc.Card([
            dbc.CardHeader(html.H4(title, className='mb-0')),
            dbc.CardBody(body)
        ], className='shadow-sm bg-dark text-light border-secondary h-100'),
        id=card_id,
        style={'height': '100%'}
    )


def make_layout(data: dict):
    summary = data['summary']
    issue = data['github'].get('issue', {})
    pr = data['github'].get('pr_watch', {})
    commits = data.get('recent_commits', [])
    timeline = data.get('timeline', [])

    initial_layout = [
        {'i': 'summary', 'x': 0, 'y': 0, 'w': 7, 'h': 3},
        {'i': 'github', 'x': 7, 'y': 0, 'w': 5, 'h': 3},
        {'i': 'series', 'x': 0, 'y': 3, 'w': 7, 'h': 5},
        {'i': 'logs', 'x': 7, 'y': 3, 'w': 5, 'h': 5},
        {'i': 'timeline', 'x': 0, 'y': 8, 'w': 6, 'h': 5},
        {'i': 'commits', 'x': 6, 'y': 8, 'w': 6, 'h': 5},
        {'i': 'findings', 'x': 0, 'y': 13, 'w': 6, 'h': 4},
        {'i': 'next', 'x': 6, 'y': 13, 'w': 6, 'h': 4},
    ]

    cards = [
        card_component('summary', 'Dashboard Summary', [
            html.P(f"Status: {summary.get('status', 'unknown')}", className='mb-2'),
            html.P('Focus: ' + ' • '.join(summary.get('focus', [])), className='mb-0'),
        ]),
        card_component('github', 'Tracked GitHub Work', [
            html.P([html.Strong('Issue: '), html.A(issue.get('title', 'n/a'), href=issue.get('url', '#'), target='_blank')]),
            html.P([html.Strong('PR: '), html.A(pr.get('title', 'n/a'), href=pr.get('url', '#'), target='_blank')]),
            html.P(pr.get('branch', ''), className='text-secondary mb-0')
        ]),
        card_component('series', '7-day Activity Series', [
            html.P(data['timeseries'].get('notes', ''), className='text-secondary'),
            dcc.Graph(figure=series_figure(data), config={'displayModeBar': False}, style={'height': '100%'})
        ]),
        card_component('logs', 'Recent Logs', [html.Pre('\n'.join(data.get('recent_logs', [])), style={'whiteSpace': 'pre-wrap', 'fontSize': '12px'})]),
        card_component('timeline', 'Progress Timeline', [html.Div([
            html.Div([html.Div(item['time'], className='text-warning small'), html.H6(item['title']), html.P(item['details'])], className='mb-3')
            for item in timeline
        ])]),
        card_component('commits', 'Recent Pushed Commits', [html.Div([
            html.P([html.Code(c['sha']), ' — ', c['message'], html.Br(), html.Span(c['time'], className='text-secondary small')])
            for c in commits
        ])]),
        card_component('findings', 'Key Findings', html.Ul([html.Li(x) for x in data.get('key_findings', [])])),
        card_component('next', 'Next Steps', html.Ul([html.Li(x) for x in data.get('next_steps', [])])),
    ]

    return dbc.Container([
        dcc.Interval(id='refresh', interval=60_000, n_intervals=0),
        dcc.Store(id='layout-store', storage_type='local'),
        html.H1('Open-FDD Testing Progress Dashboard', className='my-3'),
        html.P('Drag cards around. Layout is saved in your browser.', className='text-secondary'),
        dash_draggable.ResponsiveGridLayout(
            id='grid',
            clearSavedLayout=True,
            layouts={'lg': initial_layout},
            children=cards,
            isDraggable=True,
            isResizable=True,
            save=True,
        )
    ], fluid=True, style={'backgroundColor': '#0b1020', 'minHeight': '100vh', 'color': '#e8eefc', 'paddingBottom': '30px'})


app: Dash = Dash(__name__, external_stylesheets=[dbc.themes.DARKLY], suppress_callback_exceptions=True)
app.title = 'Open-FDD Testing Dashboard'
app.layout = lambda: make_layout(load_data())


@app.callback(Output('grid', 'children'), Input('refresh', 'n_intervals'))
def refresh_children(_):
    data = load_data()
    return make_layout(data).children[-1].children


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=8051, debug=False)
