#[allow(warnings)]
mod bindings;

use bindings::exports::theater::simple::actor::Guest;
use bindings::exports::theater::simple::http_handlers::Guest as HttpHandlersGuest;
use bindings::theater::simple::http_framework::{
    add_route, create_server, register_handler, start_server, HttpRequest, HttpResponse,
    ServerConfig,
};
use bindings::theater::simple::http_types::MiddlewareResult;
use bindings::theater::simple::runtime::log;
use bindings::theater::simple::store;
use bindings::theater::simple::websocket_types::WebsocketMessage;
use serde::{Deserialize, Serialize};

// ============================================================================
// State and Type Definitions
// ============================================================================

#[derive(Serialize, Deserialize, Debug, Clone)]
struct StoreViewerState {
    store_id: String,
    server_id: u64,
}

#[derive(Serialize, Deserialize)]
struct CreateLabelRequest {
    name: String,
    content: String,
}

#[derive(Serialize, Deserialize)]
struct UpdateLabelRequest {
    content: String,
}

#[derive(Serialize, Deserialize)]
struct LabelContentResponse {
    name: String,
    content: String,
    is_text: bool,
    size_bytes: usize,
}

// ============================================================================
// Helper Functions
// ============================================================================

fn is_text_content(bytes: &[u8]) -> bool {
    // Empty content is text
    if bytes.is_empty() {
        return true;
    }

    // Try to decode as UTF-8
    if let Ok(s) = std::str::from_utf8(bytes) {
        // Count control characters (excluding common ones like newline, tab)
        let control_chars = s
            .chars()
            .filter(|c| c.is_control() && *c != '\n' && *c != '\r' && *c != '\t')
            .count();

        // If less than 10% control characters, consider it text
        control_chars < (s.len() / 10)
    } else {
        false
    }
}

fn json_response(status: u16, body: Vec<u8>) -> HttpResponse {
    HttpResponse {
        status,
        headers: vec![("Content-Type".to_string(), "application/json".to_string())],
        body: Some(body),
    }
}

fn error_response(status: u16, message: &str) -> HttpResponse {
    let error_json = format!(r#"{{"error":"{}"}}"#, message);
    json_response(status, error_json.into_bytes())
}

// ============================================================================
// Static Asset Handlers
// ============================================================================

fn serve_index_html() -> HttpResponse {
    let html = include_str!("../assets/index.html");
    HttpResponse {
        status: 200,
        headers: vec![("Content-Type".to_string(), "text/html".to_string())],
        body: Some(html.as_bytes().to_vec()),
    }
}

fn serve_app_css() -> HttpResponse {
    let css = include_str!("../assets/app.css");
    HttpResponse {
        status: 200,
        headers: vec![("Content-Type".to_string(), "text/css".to_string())],
        body: Some(css.as_bytes().to_vec()),
    }
}

fn serve_app_js() -> HttpResponse {
    let js = include_str!("../assets/app.js");
    HttpResponse {
        status: 200,
        headers: vec![
            ("Content-Type".to_string(), "application/javascript".to_string()),
        ],
        body: Some(js.as_bytes().to_vec()),
    }
}

// ============================================================================
// API Handlers
// ============================================================================

fn handle_list_labels(state: &StoreViewerState) -> Result<HttpResponse, String> {
    log("Listing all labels");

    let labels = store::list_labels(&state.store_id)?;

    let body = serde_json::to_vec(&labels)
        .map_err(|e| format!("Failed to serialize labels: {}", e))?;

    Ok(json_response(200, body))
}

fn handle_get_label(state: &StoreViewerState, label_name: &str) -> Result<HttpResponse, String> {
    log(&format!("Getting label: {}", label_name));

    // Get the content reference for this label
    let content_ref = store::get_by_label(&state.store_id, label_name)?
        .ok_or_else(|| format!("Label not found: {}", label_name))?;

    // Retrieve the actual content
    let content_bytes = store::get(&state.store_id, &content_ref)?;

    // Determine if it's text or binary
    let is_text = is_text_content(&content_bytes);

    // Convert to appropriate string format
    let content_str = if is_text {
        String::from_utf8(content_bytes.clone())
            .unwrap_or_else(|_| "[Encoding error]".to_string())
    } else {
        // Encode binary content as base64
        use base64::{engine::general_purpose::STANDARD, Engine};
        STANDARD.encode(&content_bytes)
    };

    let response_data = LabelContentResponse {
        name: label_name.to_string(),
        content: content_str,
        is_text,
        size_bytes: content_bytes.len(),
    };

    let body = serde_json::to_vec(&response_data)
        .map_err(|e| format!("Failed to serialize response: {}", e))?;

    Ok(json_response(200, body))
}

fn handle_create_label(state: &StoreViewerState, req: &HttpRequest) -> Result<HttpResponse, String> {
    log("Creating new label");

    let body = req.body.as_ref().ok_or("Request body is required")?;

    let create_req: CreateLabelRequest = serde_json::from_slice(body)
        .map_err(|e| format!("Invalid JSON: {}", e))?;

    // Validate label name
    if create_req.name.is_empty() {
        return Ok(error_response(400, "Label name cannot be empty"));
    }

    // Store the content at the label
    let content_bytes = create_req.content.into_bytes();
    store::store_at_label(&state.store_id, &create_req.name, &content_bytes)?;

    log(&format!("Created label: {}", create_req.name));

    let success_json = r#"{"success":true}"#;
    Ok(json_response(200, success_json.as_bytes().to_vec()))
}

fn handle_update_label(
    state: &StoreViewerState,
    label_name: &str,
    req: &HttpRequest,
) -> Result<HttpResponse, String> {
    log(&format!("Updating label: {}", label_name));

    let body = req.body.as_ref().ok_or("Request body is required")?;

    let update_req: UpdateLabelRequest = serde_json::from_slice(body)
        .map_err(|e| format!("Invalid JSON: {}", e))?;

    // Store the updated content at the label (overwrites)
    let content_bytes = update_req.content.into_bytes();
    store::store_at_label(&state.store_id, label_name, &content_bytes)?;

    log(&format!("Updated label: {}", label_name));

    let success_json = r#"{"success":true}"#;
    Ok(json_response(200, success_json.as_bytes().to_vec()))
}

// ============================================================================
// Actor Implementation
// ============================================================================

struct Component;

impl Guest for Component {
    fn init(
        _state: Option<Vec<u8>>,
        params: (String,),
    ) -> Result<(Option<Vec<u8>>,), String> {
        log("Initializing store-viewer actor");
        let (actor_id,) = params;
        log(&format!("Actor ID: {}", actor_id));

        // Create store
        let store_id = "store-viewer".to_string();

        // Create HTTP server on port 8080
        let config = ServerConfig {
            port: Some(8080),
            host: Some("0.0.0.0".to_string()),
            tls_config: None,
        };

        let server_id = create_server(&config)?;
        log(&format!("Created HTTP server with ID: {}", server_id));

        // Register handler
        let handler_id = register_handler("handle_request")?;
        log(&format!("Registered handler with ID: {}", handler_id));

        // Register static asset routes
        add_route(server_id, "/", "GET", handler_id)?;
        add_route(server_id, "/app.css", "GET", handler_id)?;
        add_route(server_id, "/app.js", "GET", handler_id)?;

        // Register API routes
        add_route(server_id, "/api/labels", "GET", handler_id)?;
        add_route(server_id, "/api/labels", "POST", handler_id)?;
        add_route(server_id, "/api/labels/{*name}", "GET", handler_id)?;
        add_route(server_id, "/api/labels/{*name}", "PUT", handler_id)?;

        log("All routes registered");

        // Start the server
        start_server(server_id)?;
        log("HTTP server started on port 8080");

        // Create and serialize state
        let state = StoreViewerState { store_id, server_id };
        let state_bytes = serde_json::to_vec(&state)
            .map_err(|e| format!("Failed to serialize state: {}", e))?;

        log("Store viewer initialization complete");

        Ok((Some(state_bytes),))
    }
}

impl HttpHandlersGuest for Component {
    fn handle_request(
        state: Option<Vec<u8>>,
        params: (u64, HttpRequest),
    ) -> Result<(Option<Vec<u8>>, (HttpResponse,)), String> {
        // Deserialize state
        let state_bytes = state.ok_or("State not found")?;
        let viewer_state: StoreViewerState = serde_json::from_slice(&state_bytes)
            .map_err(|e| format!("Failed to deserialize state: {}", e))?;

        let (_server_id, req) = params;

        // Get path without query string
        let path = req.uri.split('?').next().unwrap_or("/");
        let method = req.method.as_str();

        log(&format!("Request: {} {}", method, path));

        // Route the request
        let response = match (method, path) {
            // Static assets
            ("GET", "/") => serve_index_html(),
            ("GET", "/app.css") => serve_app_css(),
            ("GET", "/app.js") => serve_app_js(),

            // API routes
            ("GET", "/api/labels") => match handle_list_labels(&viewer_state) {
                Ok(resp) => resp,
                Err(e) => {
                    log(&format!("Error listing labels: {}", e));
                    error_response(500, &e)
                }
            },

            ("POST", "/api/labels") => match handle_create_label(&viewer_state, &req) {
                Ok(resp) => resp,
                Err(e) => {
                    log(&format!("Error creating label: {}", e));
                    error_response(500, &e)
                }
            },

            ("GET", p) if p.starts_with("/api/labels/") => {
                let label_name = p.strip_prefix("/api/labels/").unwrap();
                match handle_get_label(&viewer_state, label_name) {
                    Ok(resp) => resp,
                    Err(e) => {
                        log(&format!("Error getting label: {}", e));
                        error_response(404, &e)
                    }
                }
            },

            ("PUT", p) if p.starts_with("/api/labels/") => {
                let label_name = p.strip_prefix("/api/labels/").unwrap();
                match handle_update_label(&viewer_state, label_name, &req) {
                    Ok(resp) => resp,
                    Err(e) => {
                        log(&format!("Error updating label: {}", e));
                        error_response(500, &e)
                    }
                }
            },

            // 404 for everything else
            _ => {
                log(&format!("404 Not Found: {} {}", method, path));
                HttpResponse {
                    status: 404,
                    headers: vec![("Content-Type".to_string(), "text/plain".to_string())],
                    body: Some(b"Not Found".to_vec()),
                }
            }
        };

        // Return state unchanged and the response
        Ok((Some(state_bytes), (response,)))
    }

    fn handle_middleware(
        _state: Option<Vec<u8>>,
        _params: (u64, HttpRequest),
    ) -> Result<(Option<Vec<u8>>, (MiddlewareResult,)), String> {
        unreachable!("Middleware not used")
    }

    fn handle_websocket_connect(
        _state: Option<Vec<u8>>,
        _params: (u64, u64, String, Option<String>),
    ) -> Result<(Option<Vec<u8>>,), String> {
        unreachable!("WebSocket not used")
    }

    fn handle_websocket_message(
        _state: Option<Vec<u8>>,
        _params: (u64, u64, WebsocketMessage),
    ) -> Result<(Option<Vec<u8>>, (Vec<WebsocketMessage>,)), String> {
        unreachable!("WebSocket not used")
    }

    fn handle_websocket_disconnect(
        _state: Option<Vec<u8>>,
        _params: (u64, u64),
    ) -> Result<(Option<Vec<u8>>,), String> {
        unreachable!("WebSocket not used")
    }
}

bindings::export!(Component with_types_in bindings);
