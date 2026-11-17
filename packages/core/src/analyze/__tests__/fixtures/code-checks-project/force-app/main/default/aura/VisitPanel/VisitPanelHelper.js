({
    render : function(component) {
        var el = component.find("out").getElement();
        el.innerHTML = component.get("v.message");
    }
})
