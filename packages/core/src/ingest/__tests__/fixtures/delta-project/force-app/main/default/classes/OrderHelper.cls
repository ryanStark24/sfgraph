public class OrderHelper {
  public static void touch(List<Account> a) { Util.log('touch'); }
  public static Integer count() { return [SELECT COUNT() FROM Account]; }
}
