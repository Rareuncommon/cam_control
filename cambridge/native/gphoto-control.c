// One camera handle owns serial verification, fresh validation and the write.
#include <gphoto2/gphoto2.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <math.h>
static int error(const char *s) { fprintf(stderr, "%s\n", s); return 1; }
static CameraWidget *widget(CameraWidget *root, const char *name) {
  CameraWidget *w = NULL;
  if (gp_widget_get_child_by_name(root, name, &w) < 0) return NULL;
  return w;
}
static const char *text(CameraWidget *w) { const char *v = NULL; CameraWidgetType t; if (!w || gp_widget_get_type(w, &t) < 0 || (t != GP_WIDGET_TEXT && t != GP_WIDGET_RADIO && t != GP_WIDGET_MENU)) return NULL; if (gp_widget_get_value(w, &v) < 0) return NULL; return v; }
int main(int argc, char **argv) {
  if (argc != 8) return error("Expected port, model, serial, action, key, value, expected choice");
  Camera *camera = NULL; CameraWidget *root = NULL; CameraAbilitiesList *abilities = NULL; GPPortInfoList *ports = NULL;
  int result = 1, opened = 0; CameraAbilities a; GPPortInfo port;
  if (gp_camera_new(&camera) < 0 || gp_abilities_list_new(&abilities) < 0 || gp_abilities_list_load(abilities, NULL) < 0) goto cleanup;
  int index = gp_abilities_list_lookup_model(abilities, argv[2]);
  if (index < 0 || gp_abilities_list_get_abilities(abilities, index, &a) < 0 || gp_camera_set_abilities(camera, a) < 0) goto cleanup;
  if (gp_port_info_list_new(&ports) < 0 || gp_port_info_list_load(ports) < 0) goto cleanup;
  index = gp_port_info_list_lookup_path(ports, argv[1]);
  if (index < 0 || gp_port_info_list_get_info(ports, index, &port) < 0 || gp_camera_set_port_info(camera, port) < 0 || gp_camera_init(camera, NULL) < 0) goto cleanup;
  opened = 1;
  if (gp_camera_get_config(camera, &root, NULL) < 0) goto cleanup;
  const char *serial = text(widget(root, "serialnumber"));
  if (!serial || !*serial || strcmp(serial, argv[3])) { error("Camera serial changed; refusing write"); goto cleanup; }
  if (!strcmp(argv[4], "capture")) {
    const char *target = text(widget(root, "capturetarget")), *shutter = text(widget(root, "shutterspeed"));
    if (!target || (strcasecmp(target, "Memory card") && strcasecmp(target, "SD card") && strcasecmp(target, "CF card") && strcasecmp(target, "Card")) || !shutter || strcasestr(shutter, "bulb")) { error("Capture needs a memory-card target and known non-Bulb shutter"); goto cleanup; }
    CameraFilePath path;
    if (gp_camera_capture(camera, GP_CAPTURE_IMAGE, &path, NULL) < 0) goto cleanup;
    puts("CAPTURED"); result = 0; goto cleanup;
  }
  if (strcmp(argv[4], "set")) goto cleanup;
  const char *name = strrchr(argv[5], '/'); name = name ? name + 1 : argv[5];
  if (strcmp(name,"iso") && strcmp(name,"aperture") && strcmp(name,"f-number") && strcmp(name,"shutterspeed") && strcmp(name,"exposurecompensation") && strcmp(name,"whitebalance")) goto cleanup;
  CameraWidget *w = widget(root, name); CameraWidgetType type; int readonly = 1;
  if (!w || gp_widget_get_readonly(w, &readonly) < 0 || readonly || gp_widget_get_type(w, &type) < 0) goto cleanup;
  char *end; double value = strtod(argv[6], &end); if (*end || !isfinite(value)) goto cleanup;
  if (type == GP_WIDGET_RADIO || type == GP_WIDGET_MENU) {
    int count = gp_widget_count_choices(w); const char *choice;
    if (value < 0 || value >= count || floor(value) != value || gp_widget_get_choice(w, (int)value, &choice) < 0 || strcmp(choice, argv[7]) || gp_widget_set_value(w, choice) < 0) goto cleanup;
  } else if (type == GP_WIDGET_RANGE) {
    float min, max, step, val = (float)value;
    if (gp_widget_get_range(w, &min, &max, &step) < 0 || val < min || val > max || step <= 0 || fabs((value-min)/step-round((value-min)/step)) > 0.001 || gp_widget_set_value(w, &val) < 0) goto cleanup;
  } else goto cleanup;
  if (gp_camera_set_single_config(camera, name, w, NULL) < 0) goto cleanup;
  puts("SET"); result = 0;
cleanup:
  if (root) gp_widget_free(root);
  if (opened) gp_camera_exit(camera, NULL);
  if (camera) gp_camera_free(camera);
  if (abilities) gp_abilities_list_free(abilities);
  if (ports) gp_port_info_list_free(ports);
  if (result) error("Camera operation failed or was refused; no automatic retry");
  return result;
}
