// Native helper guard harness. Uses real libgphoto widget trees and no devices.
#define main helper_main
#include "../native/gphoto-control.c"
#undef main
#include <assert.h>
static const char *mock_serial = "SERIAL-A", *mock_shutter = "1/50", *mock_target = "Memory card";
static int writes = 0, captures = 0;
int gp_camera_init(Camera *c, GPContext *ctx) { (void)c; (void)ctx; return 0; }
int gp_camera_exit(Camera *c, GPContext *ctx) { (void)c; (void)ctx; return 0; }
int gp_camera_set_port_info(Camera *c, GPPortInfo p) { (void)c; (void)p; return 0; }
int gp_port_info_list_lookup_path(GPPortInfoList *l, const char *p) { (void)l; (void)p; return 0; }
int gp_port_info_list_get_info(GPPortInfoList *l, int n, GPPortInfo *p) { (void)l; (void)n; *p = NULL; return 0; }
static void child(CameraWidget *root, const char *name, const char *value, int readonly, CameraWidgetType type) {
  CameraWidget *w; assert(gp_widget_new(type, name, &w) >= 0); gp_widget_set_name(w, name);
  if (type == GP_WIDGET_RADIO) { gp_widget_add_choice(w,"100"); gp_widget_add_choice(w,"400"); }
  gp_widget_set_value(w, value); gp_widget_set_readonly(w, readonly); gp_widget_append(root,w);
}
int gp_camera_get_config(Camera *c, CameraWidget **w, GPContext *ctx) {
  (void)c; (void)ctx; gp_widget_new(GP_WIDGET_WINDOW,"main",w);
  child(*w,"serialnumber",mock_serial,1,GP_WIDGET_TEXT);
  child(*w,"shutterspeed",mock_shutter,1,GP_WIDGET_TEXT);
  child(*w,"capturetarget",mock_target,0,GP_WIDGET_TEXT);
  child(*w,"iso","100",0,GP_WIDGET_RADIO); return 0;
}
int gp_camera_set_single_config(Camera *c,const char *name,CameraWidget *w,GPContext *ctx) { (void)c; (void)w; (void)ctx; assert(!strcmp(name,"iso")); writes++; return 0; }
int gp_camera_capture(Camera *c,CameraCaptureType type,CameraFilePath *path,GPContext *ctx) { (void)c; (void)type; (void)path; (void)ctx; captures++; return 0; }
int main(void) {
  char *args[]={"helper","usb:001,002","Canon EOS R5","SERIAL-A","set","/main/imgsettings/iso","1","400"};
  assert(helper_main(8,args)==0 && writes==1);
  args[7]="800"; assert(helper_main(8,args)!=0 && writes==1); args[7]="400";
  mock_serial="SERIAL-B"; assert(helper_main(8,args)!=0 && writes==1); mock_serial="SERIAL-A";
  args[6]="99"; assert(helper_main(8,args)!=0 && writes==1);
  args[4]="capture"; args[5]=""; args[6]="";
  mock_shutter="Bulb"; assert(helper_main(8,args)!=0 && captures==0); mock_shutter="1/50";
  mock_target="Internal RAM"; assert(helper_main(8,args)!=0 && captures==0); mock_target="Memory card";
  assert(helper_main(8,args)==0 && captures==1);
  puts("PASS: native USB helper identity, allowed value, read-only Bulb, memory target, set and capture guards");
}
