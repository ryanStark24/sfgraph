@isTest
public class AccountControllerTest {
    @isTest
    static void testGetAccount() {
        Account a = AccountController.getAccountById(null);
        System.assertEquals(null, a);
    }
}
