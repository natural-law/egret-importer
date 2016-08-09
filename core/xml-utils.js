'use strict';

function shouldIgnoreNode (node) {
    return node.nodeType === 3 // text
        || node.nodeType === 8   // comment
        || node.nodeType === 4 // cdata
        || node.nodeType === 7;  // process instruction
}

function getPropertyInOrder(node, propList, defaltValue) {
    var ret = defaltValue;
    for (var idx in propList) {
        var propName = propList[idx];
        var tempValue = getPropertyOfNode(node, propName, '');
        if (tempValue) {
            ret = tempValue;
            break;
        }
    }

    return ret;
}

function getPropertyOfNode (baseNode, propertyName, defaultValue, childNodeName) {
    var theNode = baseNode;
    if (childNodeName) {
        theNode = getFirstChildNodeByName(baseNode, childNodeName);
    }

    if (theNode) {
        var theValue = theNode.getAttribute(propertyName);
        if (!theValue) {
            return defaultValue;
        } else {
            return theValue;
        }
    }

    return defaultValue;
}

function getIntPropertyOfNode (baseNode, propertyName, defaultValue, childNodeName) {
    var theValue = getPropertyOfNode(baseNode, propertyName, defaultValue, childNodeName);
    if (typeof theValue === 'string' && theValue.constructor === String) {
        theValue = parseInt(theValue);
    }

    return theValue;
}

function getFloatPropertyOfNode (baseNode, propertyName, defaultValue, childNodeName) {
    var theValue = getPropertyOfNode(baseNode, propertyName, defaultValue, childNodeName);
    if (typeof theValue === 'string' && theValue.constructor === String) {
        theValue = parseFloat(theValue);
    }

    return theValue;
}

function getBoolPropertyOfNode (baseNode, propertyName, defaultValue, childNodeName) {
    var theValue = getPropertyOfNode(baseNode, propertyName, defaultValue, childNodeName);
    if (typeof theValue === 'string' && theValue.constructor === String) {
        return theValue.toLowerCase() === 'true';
    }

    return theValue;
}

function getFirstChildNodeByLocalName (baseNode, name) {
    if (!baseNode) {
        return null;
    }

    var childNodes = baseNode.childNodes;
    for (var i = 0, n = childNodes.length; i < n; i++) {
        var childNode = childNodes[i];
        if (shouldIgnoreNode(childNode) || childNode.localName !== name) {
            continue;
        }

        return childNode;
    }

    return null;
}

function getChildNodesByName (baseNode, name) {
    var ret = [];
    if (!baseNode) {
        return ret;
    }

    var childNodes = baseNode.childNodes;
    for (var i = 0, n = childNodes.length; i < n; i++) {
        var childNode = childNodes[i];
        if (shouldIgnoreNode(childNode) || childNode.nodeName !== name) {
            continue;
        }

        ret.push(childNode);
    }

    return ret;
}

function getAllChildren(baseNode) {
    var ret = [];
    if (!baseNode) {
        return ret;
    }

    var childNodes = baseNode.childNodes;
    for (var i = 0, n = childNodes.length; i < n; i++) {
        var childNode = childNodes[i];
        if (shouldIgnoreNode(childNode)) {
            continue;
        }

        ret.push(childNode);
    }

    return ret;
}

module.exports = {
    shouldIgnoreNode: shouldIgnoreNode,
    getPropertyInOrder: getPropertyInOrder,
    getPropertyOfNode: getPropertyOfNode,
    getIntPropertyOfNode: getIntPropertyOfNode,
    getFloatPropertyOfNode: getFloatPropertyOfNode,
    getBoolPropertyOfNode: getBoolPropertyOfNode,
    getFirstChildNodeByLocalName: getFirstChildNodeByLocalName,
    getChildNodesByName: getChildNodesByName,
    getAllChildren: getAllChildren
};
