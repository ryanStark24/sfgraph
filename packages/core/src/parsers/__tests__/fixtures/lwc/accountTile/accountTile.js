import getAccountById from "@salesforce/apex/AccountController.getAccountById";
import LBL_TITLE from "@salesforce/label/c.Account_Tile_Title";
import myLogo from "@salesforce/resourceUrl/AcmeLogo";
import { LightningElement, api, wire } from "lwc";

export default class AccountTile extends LightningElement {
  @api recordId;
  @wire(getAccountById, { accountId: "$recordId" }) account;

  handleClick() {
    getAccountById({ accountId: this.recordId }).then((res) => {
      this.dispatchEvent(new CustomEvent("selected", { detail: res }));
    });
  }
}
