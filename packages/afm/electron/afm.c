// The Node-API addon around AfmBridge (AfmNode.swift): `call(method, optionsJson)`
// returns `{ result }` or `{ error }` in JSON, and `setListener(fn)` gets each
// event in JSON. Events come from Swift's threads, so they reach JavaScript through
// a thread-safe function, on Node's own thread.
#define NAPI_VERSION 8
#include <node_api.h>
#include <stdlib.h>
#include <string.h>

typedef void (*afm_listener)(const char *json);
extern void afm_set_listener(afm_listener listener);
extern char *afm_call(const char *method, const char *options);
extern void afm_free(char *pointer);

static napi_threadsafe_function events = NULL;

static void call_js(napi_env env, napi_value callback, void *context, void *data) {
    (void)context;
    char *json = data;
    if (env != NULL && callback != NULL) {
        napi_value argument, undefined;
        napi_create_string_utf8(env, json, NAPI_AUTO_LENGTH, &argument);
        napi_get_undefined(env, &undefined);
        napi_call_function(env, undefined, callback, 1, &argument, NULL);
    }
    free(json);
}

static void on_event(const char *json) {
    napi_threadsafe_function target = events;
    if (target == NULL) return;
    char *copy = strdup(json);
    if (napi_call_threadsafe_function(target, copy, napi_tsfn_nonblocking) != napi_ok) free(copy);
}

static char *string_argument(napi_env env, napi_value value) {
    size_t length = 0;
    if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok) return NULL;
    char *string = malloc(length + 1);
    napi_get_value_string_utf8(env, value, string, length + 1, &length);
    return string;
}

static napi_value set_listener(napi_env env, napi_callback_info info) {
    size_t count = 1;
    napi_value arguments[1];
    napi_get_cb_info(env, info, &count, arguments, NULL, NULL);
    if (events != NULL) {
        afm_set_listener(NULL);
        napi_release_threadsafe_function(events, napi_tsfn_abort);
        events = NULL;
    }
    napi_valuetype type = napi_undefined;
    if (count > 0) napi_typeof(env, arguments[0], &type);
    if (type == napi_function) {
        napi_value name;
        napi_create_string_utf8(env, "afm events", NAPI_AUTO_LENGTH, &name);
        napi_create_threadsafe_function(env, arguments[0], NULL, name, 0, 1, NULL, NULL, NULL, call_js, &events);
        // Events don't keep the process running.
        napi_unref_threadsafe_function(env, events);
        afm_set_listener(on_event);
    }
    return NULL;
}

static napi_value call(napi_env env, napi_callback_info info) {
    size_t count = 2;
    napi_value arguments[2];
    napi_get_cb_info(env, info, &count, arguments, NULL, NULL);
    char *method = count > 0 ? string_argument(env, arguments[0]) : NULL;
    char *options = count > 1 ? string_argument(env, arguments[1]) : NULL;
    if (method == NULL || options == NULL) {
        free(method);
        free(options);
        napi_throw_type_error(env, NULL, "call(method, optionsJson) takes two strings");
        return NULL;
    }
    char *reply = afm_call(method, options);
    napi_value result;
    napi_create_string_utf8(env, reply, NAPI_AUTO_LENGTH, &result);
    afm_free(reply);
    free(method);
    free(options);
    return result;
}

NAPI_MODULE_INIT() {
    napi_property_descriptor properties[] = {
        { "call", NULL, call, NULL, NULL, NULL, napi_default, NULL },
        { "setListener", NULL, set_listener, NULL, NULL, NULL, napi_default, NULL }
    };
    napi_define_properties(env, exports, 2, properties);
    return exports;
}
