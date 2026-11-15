import { LightningElement, api } from 'lwc';

export default class VisitClean extends LightningElement {
    @api text;

    renderedCallback() {
        const el = this.template.querySelector('.out');
        // textContent is safe, clearing is safe, reading is safe.
        el.textContent = this.text;
        el.innerHTML = '';
        const before = el.innerHTML;
        // el.innerHTML = this.text;  (commented out)
        if (el.innerHTML === before) {
            return;
        }
    }
}
