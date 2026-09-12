// Reads installed libgphoto2 driver metadata only. Never opens a camera.
// Build with your libgphoto2 include/library paths and -lgphoto2.
#include <stdio.h>
#include <gphoto2/gphoto2.h>
#include <gphoto2/gphoto2-version.h>
int main(void) {
  printf("# libgphoto2 %s\n", gp_library_version(GP_VERSION_SHORT)[0]);
  CameraAbilitiesList *list;
  if (gp_abilities_list_new(&list) < 0 || gp_abilities_list_load(list, NULL) < 0) return 1;
  for (int i = 0; i < gp_abilities_list_count(list); i++) {
    CameraAbilities a;
    if (gp_abilities_list_get_abilities(list, i, &a) < 0) return 1;
    if (a.device_type == GP_DEVICE_STILL_CAMERA && a.status == GP_DRIVER_STATUS_PRODUCTION && (a.port & GP_PORT_USB) && (a.operations & GP_OPERATION_CONFIG) && (a.operations & GP_OPERATION_CAPTURE_IMAGE)) printf("%s\n", a.model);
  }
  gp_abilities_list_free(list);
  return 0;
}
