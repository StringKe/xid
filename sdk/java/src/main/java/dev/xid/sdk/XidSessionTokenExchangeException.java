package dev.xid.sdk;

/**
 * Core opaque browser-session cookie exchange failed closed.
 */
public class XidSessionTokenExchangeException extends XidException {
    public XidSessionTokenExchangeException(String message) {
        super(message);
    }

    public XidSessionTokenExchangeException(String message, Throwable cause) {
        super(message, cause);
    }
}
