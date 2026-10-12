global class CheckoutSvc implements vlocity_cmt.VlocityOpenInterface {
  global Boolean invokeMethod(String m, Map<String,Object> i, Map<String,Object> o, Map<String,Object> p) {
    return submit(i);
  }
  public Boolean submit(Map<String,Object> i) { return true; }
}
