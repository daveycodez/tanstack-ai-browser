// macOS's location permission for the app, as a Node-API addon for the main
// process (electron/location.ts). Electron grants a page's geolocation request
// itself, without asking macOS, and Chromium looks up no position until macOS
// allows the app (electron/electron#45290): this asks macOS.
//
// A location manager learns the app's permission from macOS after it's made:
// until its delegate hears, it reports "not determined", whatever macOS has
// decided. So the addon passes on what the delegate hears, the first time and
// every change after, and never reads the status on its own.
//
// Everything runs on the main thread, where the manager must live while macOS
// shows its prompt.
#import <CoreLocation/CoreLocation.h>
#import <Foundation/Foundation.h>
#include <node_api.h>
#include <stdlib.h>
#include <string.h>

static napi_threadsafe_function listener;

// macOS asks only for an app whose Info.plist says why it wants the location.
static BOOL canAsk(void) {
  NSDictionary *info = NSBundle.mainBundle.infoDictionary;
  return info[@"NSLocationUsageDescription"] != nil || info[@"NSLocationWhenInUseUsageDescription"] != nil;
}

static const char *statusName(CLLocationManager *manager) {
  if (!CLLocationManager.locationServicesEnabled) return "off";
  switch (manager.authorizationStatus) {
    case kCLAuthorizationStatusNotDetermined:
      return canAsk() ? "notDetermined" : "cannotAsk";
    case kCLAuthorizationStatusRestricted:
      return "restricted";
    case kCLAuthorizationStatusDenied:
      return "denied";
    default:
      return "allowed";
  }
}

@interface AuthorizationDelegate : NSObject <CLLocationManagerDelegate>
@end

@implementation AuthorizationDelegate
- (void)locationManagerDidChangeAuthorization:(CLLocationManager *)manager {
  if (!listener) return;
  napi_call_threadsafe_function(listener, strdup(statusName(manager)), napi_tsfn_nonblocking);
}
@end

static CLLocationManager *manager;
static AuthorizationDelegate *delegate;

static void callListener(napi_env env, napi_value callback, void *context, void *data) {
  char *status = data;
  if (env && callback) {
    napi_value argument, global;
    napi_create_string_utf8(env, status, NAPI_AUTO_LENGTH, &argument);
    napi_get_global(env, &global);
    napi_call_function(env, global, callback, 1, &argument, NULL);
  }
  free(status);
}

// watch(listener): calls listener with the app's permission once macOS has
// told it, and again on every change: "allowed", "denied", "restricted",
// "notDetermined", "off" (Location Services is off for the whole Mac) or
// "cannotAsk" (no reason in Info.plist, so macOS won't ask).
static napi_value Watch(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value callback, name;
  napi_get_cb_info(env, info, &argc, &callback, NULL, NULL);
  if (listener || argc < 1) return NULL;
  napi_create_string_utf8(env, "location", NAPI_AUTO_LENGTH, &name);
  napi_create_threadsafe_function(env, callback, NULL, name, 0, 1, NULL, NULL, NULL, callListener, &listener);
  // It mustn't keep the app running.
  napi_unref_threadsafe_function(env, listener);
  delegate = [[AuthorizationDelegate alloc] init];
  manager = [[CLLocationManager alloc] init];
  manager.delegate = delegate;
  return NULL;
}

// request(): shows macOS's prompt, when it hasn't been answered. The answer
// comes to watch's listener.
static napi_value Request(napi_env env, napi_callback_info info) {
  [manager requestWhenInUseAuthorization];
  return NULL;
}

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
    {"watch", NULL, Watch, NULL, NULL, NULL, napi_default, NULL},
    {"request", NULL, Request, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, 2, properties);
  return exports;
}
