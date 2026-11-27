import { LightningElement } from 'lwc';

export default class VisitBanner extends LightningElement {
    renderedCallback() {
        const el = this.template.querySelector('.banner');
        // A fixed string: no data flows in.
        el.innerHTML = '<b>Welcome</b>';
    }
}
