/*
    ***** BEGIN LICENSE BLOCK *****
    
    Copyright © 2009 Center for History and New Media
                     George Mason University, Fairfax, Virginia, USA
                     http://zotero.org
    
    This file is part of Zotero.
    
    Zotero is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
    
    Zotero is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.
    
    You should have received a copy of the GNU Affero General Public License
    along with Zotero.  If not, see <http://www.gnu.org/licenses/>.
    
    ***** END LICENSE BLOCK *****
*/

/**
 * A singleton to handle URL rewriting proxies
 * @namespace
 * @property transparent {Boolean} Whether transparent proxy functionality is enabled
 * @property proxies {Zotero.Proxy[]} All loaded proxies
 * @property hosts {Zotero.Proxy{}} Object mapping hosts to proxies
 */
Zotero.Proxies = new function() {
	this.proxies = false;
	this.transparent = false;
	this.hosts = {};
	
	
	/**
	 * Initializes http-on-examine-response observer to intercept page loads and gets preferences
	 */
	this.init = Zotero.Promise.coroutine(function* () {
		if(!this.proxies) {
			var me = this;
			Zotero.MIMETypeHandler.addObserver(function(ch) { me.observe(ch) });
			
			var rows = yield Zotero.DB.queryAsync("SELECT * FROM proxies");
			Zotero.Proxies.proxies = yield Zotero.Promise.all(
				rows.map(row => this.newProxyFromRow(row))
			);
			
			for (let proxy of Zotero.Proxies.proxies) {
				for (let host of proxy.hosts) {
					Zotero.Proxies.hosts[host] = proxy;
				}
			}
		}
		
		Zotero.Proxies.transparent = !Zotero.isConnector && Zotero.Prefs.get("proxies.transparent");
		Zotero.Proxies.autoRecognize = Zotero.Proxies.transparent && Zotero.Prefs.get("proxies.autoRecognize");
		
		var disableByDomainPref = Zotero.Prefs.get("proxies.disableByDomain");
		Zotero.Proxies.disableByDomain = (Zotero.Proxies.transparent && disableByDomainPref ? Zotero.Prefs.get("proxies.disableByDomainString") : null);
		
		Zotero.Proxies.lastIPCheck = 0;
		Zotero.Proxies.lastIPs = "";
		Zotero.Proxies.disabledByDomain = false;
		
		Zotero.Proxies.showRedirectNotification = Zotero.Prefs.get("proxies.showRedirectNotification");
	});
	
	
	/**
	 * @param {Object} row - Database row with proxy data
	 * @return {Promise<Zotero.Proxy>}
	 */
	this.newProxyFromRow = Zotero.Promise.coroutine(function* (row) {
		var proxy = new Zotero.Proxy(row);
		yield proxy.loadHosts();
		return proxy;
	});
	
	
	/**
	 * Observe method to capture page loads and determine if they're going through an EZProxy.
	 *
	 * @param {nsIChannel} channel
	 */
	this.observe = Zotero.Promise.coroutine(function* (channel) {
		// try to detect a proxy
		channel.QueryInterface(Components.interfaces.nsIHttpChannel);
		var url = channel.URI.spec;
		
		try {
			var { browser, window } = _getBrowserAndWindow(channel);
		}
		catch (e) {
			Zotero.logError(e);
		}
		if (!browser) {
			Zotero.debug("Couldn't get browser from channel", 2);
		}
		
		// see if there is a proxy we already know
		var m = false;
		var proxy;
		for (proxy of Zotero.Proxies.proxies) {
			if(proxy.proxyID && proxy.regexp && proxy.multiHost) {
				m = proxy.regexp.exec(url);
				if(m) break;
			}
		}
		
		if(m) {
			var host = m[proxy.parameters.indexOf("%h")+1];
			// add this host if we know a proxy
			if(proxy.autoAssociate							// if autoAssociate is on
				&& channel.responseStatus < 400				// and query was successful
				&& !Zotero.Proxies.hosts[host]				// and host is not saved
				&& proxy.hosts.indexOf(host) === -1
				&& !_isBlacklisted(host)					// and host is not blacklisted
			) {	
				proxy.hosts.push(host);
				yield proxy.save(true);
				
				if (!browser) return;
				_showNotification(
					browser,
					window,
					Zotero.getString('proxies.notification.associated.label', [host, channel.URI.hostPort]),
					[
						{
							label: "proxies.notification.settings.button",
							callback: () => _prefsOpenCallback(window)
						}
					]
				);
			}
		} else {
			if (!browser) return;
			
			// otherwise, try to detect a proxy
			var proxy = false;
			for(var detectorName in Zotero.Proxies.Detectors) {
				var detector = Zotero.Proxies.Detectors[detectorName];
				try {
					proxy = detector(channel);
				} catch(e) {
					Zotero.logError(e);
				}
				
				if(!proxy) continue;
				Zotero.debug("Proxies: Detected "+detectorName+" proxy "+proxy.scheme+
					(proxy.multiHost ? " (multi-host)" : " for "+proxy.hosts[0]));
				
				var savedTransparent = false;
				if(Zotero.Proxies.autoRecognize) {
					// Ask to save only if automatic proxy recognition is on
					savedTransparent = _showNotification(
						browser,
						window,
						Zotero.getString('proxies.notification.recognized.label', [proxy.hosts[0], channel.URI.hostPort]),
						[{ label: "proxies.notification.enable.button", callback: function() { _showDialog(proxy.hosts[0], channel.URI.hostPort, proxy); } }]);
				}
				
				yield proxy.save();
				
				break;
			}
		}
		
		// try to get an applicable proxy
		var docShell = browser.docShell;
		if (!docShell) {
			Zotero.logError("Couldn't get docshell");
			return;
		}
		
		if (!docShell || !docShell.allowMetaRedirects) return;
		
		// check that proxy redirection is actually enabled
		if(!Zotero.Proxies.transparent) return;
		
		var proxied = Zotero.Proxies.properToProxy(url, true);
		if(!proxied) return;
		
		if(Zotero.Proxies.disableByDomain) {
			var now = new Date();
			
			// IP update interval is every 15 minutes
			if((now - Zotero.Proxies.lastIPCheck) > 900000) {
				Zotero.Proxies.DNS.getHostnames().then(function (hosts) {
					// if domains necessitate disabling, disable them
					Zotero.Proxies.disabledByDomain = false;
					for (var host of hosts) {
						Zotero.Proxies.disabledByDomain = host.toLowerCase().indexOf(Zotero.Proxies.disableByDomain) != -1;
						if (Zotero.Proxies.disabledByDomain) return;
					}
					_maybeRedirect(channel, browser, window, proxied);
				}, function(e) {
					_maybeRedirect(channel, browser, window, proxied);
				});
				Zotero.Proxies.lastIPCheck = now;
				return;
			}
			
			if(Zotero.Proxies.disabledByDomain) return;
		}
		
		_maybeRedirect(channel, browser, window, proxied);
	});

	function _maybeRedirect(channel, browser, window, proxied) {
		channel.QueryInterface(Components.interfaces.nsIHttpChannel);				
		var proxiedURI = Services.io.newURI(proxied, null, null);
		if(channel.referrer) {
			// If the referrer is a proxiable host, we already have access (e.g., we're
			// on-campus) and shouldn't redirect
			if(Zotero.Proxies.properToProxy(channel.referrer.spec, true)) {
				Zotero.debug("Proxies: skipping redirect; referrer was proxiable");
				return;
			}
			// If the referrer is the same host as we're about to redirect to, we shouldn't
			// or we risk a loop
			if(channel.referrer.host == proxiedURI.host) {
				Zotero.debug("Proxies: skipping redirect; redirect URI and referrer have same host");
				return;
			}
		}
		
		if(channel.originalURI) {
			// If the original URI was a proxied host, we also shouldn't redirect, since any
			// links handed out by the proxy should already be proxied
			if(Zotero.Proxies.proxyToProper(channel.originalURI.spec, true)) {
				Zotero.debug("Proxies: skipping redirect; original URI was proxied");
				return;
			}
			// Finally, if the original URI is the same as the host we're about to redirect
			// to, then we also risk a loop
			if(channel.originalURI.host == proxiedURI.host) {
				Zotero.debug("Proxies: skipping redirect; redirect URI and original URI have same host");
				return;
			}
		}
		
		// make sure that the top two domains (e.g. gmu.edu in foo.bar.gmu.edu) of the
		// channel and the site to which we're redirecting don't match, to prevent loops.
		const top2DomainsRe = /[^\.]+\.[^\.]+$/;
		top21 = top2DomainsRe.exec(channel.URI.host);
		top22 = top2DomainsRe.exec(proxiedURI.host);
		if(!top21 || !top22 || top21[0] == top22[0]) {
			Zotero.debug("Proxies: skipping redirect; redirect URI and URI have same top 2 domains");
			return;
		}
		
		// Otherwise, redirect. Note that we save the URI we're redirecting from as the
		// referrer, since we can't make a proper redirect
		if(Zotero.Proxies.showRedirectNotification) {
			_showNotification(
				browser,
				window,
				Zotero.getString('proxies.notification.redirected.label', [channel.URI.hostPort, proxiedURI.hostPort]),
				[
					{
						label: "general.dontShowAgain",
						callback: () => _disableRedirectNotification()
					},
					{
						label: "proxies.notification.settings.button",
						callback: () => _prefsOpenCallback(window)
					}
				]
			);
		}

		browser.loadURIWithFlags(proxied, 0, channel.URI, null, null);
	}
	
	/**
	 * Removes a proxy object from the list of proxy objects
	 * @returns {Boolean} True if the proxy was in the list, false if it was not
	 */
	this.remove = function(proxy) {
		var index = Zotero.Proxies.proxies.indexOf(proxy);
		if(index == -1) return false;
		// remove proxy from proxy list
		Zotero.Proxies.proxies.splice(index, 1);
		// remove hosts from host list
		for(var host in Zotero.Proxies.hosts) {
			if(Zotero.Proxies.hosts[host] == proxy) {
				delete Zotero.Proxies.hosts[host];
			}
		}
		return true;
	}
	
	/**
	 * Inserts a proxy into the host map; necessary when proxies are added
	 */
	this.save = function(proxy) {
		// add to list of proxies
		if(Zotero.Proxies.proxies.indexOf(proxy) == -1) Zotero.Proxies.proxies.push(proxy);
		
		// if there is a proxy ID (i.e., if this is a persisting, transparent proxy), add to host
		// list to do reverse mapping
		if(proxy.proxyID) {
			for (let host of proxy.hosts) {
				Zotero.Proxies.hosts[host] = proxy;
			}
		}
	}
	
	/**
	 * Refreshes host map; necessary when proxies are changed or deleted
	 */
	this.refreshHostMap = function(proxy) {
		// if there is no proxyID, then return immediately, since there is no need to update
		if(!proxy.proxyID) return;
		
		// delete hosts that point to this proxy if they no longer exist
		for(var host in Zotero.Proxies.hosts) {
			if(Zotero.Proxies.hosts[host] == proxy && proxy.hosts.indexOf(host) == -1) {
				delete Zotero.Proxies.hosts[host];
			}
		}
		// add new hosts for this proxy
		Zotero.Proxies.save(proxy);
	}
	
	/**
	 * Returns a page's proper URL from a proxied URL. Uses both transparent and opaque proxies.
	 * @param {String} url
	 * @param {Boolean} onlyReturnIfProxied Controls behavior if the given URL is not proxied. If
	 *	it is false or unspecified, unproxied URLs are returned verbatim. If it is true, the
	 *	function will return "false" if the given URL is unproxied.
	 * @type String
	 */
	this.proxyToProper = function(url, onlyReturnIfProxied) {
		for (let proxy of Zotero.Proxies.proxies) {
			if(proxy.regexp) {
				var m = proxy.regexp.exec(url);
				if(m) {
					var toProper = proxy.toProper(m);
					Zotero.debug("Proxies.proxyToProper: "+url+" to "+toProper);
					return toProper;
				}
			}
		}
		return (onlyReturnIfProxied ? false : url);
	}
	
	/**
	 * Returns a page's proxied URL from the proper URL. Uses only transparent proxies.
	 * @param {String} url
	 * @param {Boolean} onlyReturnIfProxied Controls behavior if the given URL is not proxied. If
	 *	it is false or unspecified, unproxied URLs are returned verbatim. If it is true, the
	 *	function will return "false" if the given URL is unproxied.
	 * @type String
	 */
	this.properToProxy = function(url, onlyReturnIfProxied) {
		var uri = Services.io.newURI(url, null, null);
		if(Zotero.Proxies.hosts[uri.hostPort] && Zotero.Proxies.hosts[uri.hostPort].proxyID) {
			var toProxy = Zotero.Proxies.hosts[uri.hostPort].toProxy(uri);
			Zotero.debug("Proxies.properToProxy: "+url+" to "+toProxy);
			return toProxy;
		}
		return (onlyReturnIfProxied ? false : url);
	}
	
	/**
	 * Check the url for potential proxies and deproxify, providing a scheme to build
	 * a proxy object.
	 * 
	 * @param URL
	 * @returns {Object} Unproxied url to proxy object
	 */
	this.getPotentialProxies = function(URL) {
		var urlToProxy = {};
		// If it's a known proxied URL just return it
		if (Zotero.Proxies.transparent) {
			for (var proxy of Zotero.Proxies.proxies) {
				if (proxy.regexp) {
					var m = proxy.regexp.exec(URL);
					if (m) {
						let proper = proxy.toProper(m);
						urlToProxy[proper] = proxy.toJSON();
						return urlToProxy;
					}
				}
			}
		}
		urlToProxy[URL] = null;
		
		// if there is a subdomain that is also a TLD, also test against URI with the domain
		// dropped after the TLD
		// (i.e., www.nature.com.mutex.gmu.edu => www.nature.com)
		var m = /^(https?:\/\/)([^\/]+)/i.exec(URL);
		if (m) {
			// First, drop the 0- if it exists (this is an III invention)
			var host = m[2];
			if (host.substr(0, 2) === "0-") host = host.substr(2);
			var hostnameParts = [host.split(".")];
			if (m[1] == 'https://' && host.replace(/-/g, '.') != host) {
				// try replacing hyphens with dots for https protocol
				// to account for EZProxy HttpsHypens mode
				hostnameParts.push(host.replace(/-/g, '.').split('.'));
			}
			
			for (let i=0; i < hostnameParts.length; i++) {
				let parts = hostnameParts[i];
				// If hostnameParts has two entries, then the second one is with replaced hyphens
				let dotsToHyphens = i == 1;
				// skip the lowest level subdomain, domain and TLD
				for (let j=1; j<parts.length-2; j++) {
					// if a part matches a TLD, everything up to it is probably the true URL
					if (TLDS[parts[j].toLowerCase()]) {
						var properHost = parts.slice(0, j+1).join(".");
						// protocol + properHost + /path
						var properURL = m[1]+properHost+URL.substr(m[0].length);
						var proxyHost = parts.slice(j+1).join('.');
						urlToProxy[properURL] = {scheme: m[1] + '%h.' + proxyHost + '/%p', dotsToHyphens};
					}
				}
			}
		}
		return urlToProxy;
	};
	
	/**
	 * Determines whether a host is blacklisted, i.e., whether we should refuse to save transparent
	 * proxy entries for this host. This is necessary because EZProxy offers to proxy all Google and
	 * Wikipedia subdomains, but in practice, this would get really annoying.
	 *
	 * @type Boolean
	 * @private
	 */
	 function _isBlacklisted(host) {
	 	/**
	 	 * Regular expression patterns of hosts never to proxy
	 	 * @const
	 	 */
		const hostBlacklist = [
			/edu$/,
			/google\.com$/,
			/wikipedia\.org$/,
			/^[^.]*$/,
			/doubleclick\.net$/
		];
	 	/**
	 	 * Regular expression patterns of hosts that should always be proxied, regardless of whether
	 	 * they're on the blacklist
	 	 * @const
	 	 */
		const hostWhitelist = [
			/^scholar\.google\.com$/,
			/^muse\.jhu\.edu$/
		]
		
		for (let blackPattern of hostBlacklist) {
			if(blackPattern.test(host)) {
				for (let whitePattern of hostWhitelist) {
					if(whitePattern.test(host)) {
						return false;
					}
				}
				return true;
			}
		}
		return false;
	 }
	 
	 /**
	  * If transparent is enabled, shows a dialog asking user whether to add a proxy to the
	  * transparent proxy list.
	  *
	  * @param {String} proxiedHost The host that would be redirected through the proxy.
	  * @param {String} proxyHost The host through which the given site would be redirected.
	  * @returns {Boolean} True if proxy should be added; false if it should not be.
	  */
	 var _showDialog = Zotero.Promise.coroutine(function* (proxiedHost, proxyHost, proxy) {
		// ask user whether to add this proxy
		var io = {site:proxiedHost, proxy:proxyHost};
		var window = Components.classes["@mozilla.org/appshell/window-mediator;1"]
			.getService(Components.interfaces.nsIWindowMediator)
			.getMostRecentWindow("navigator:browser");
		window.openDialog('chrome://zotero/content/proxy.xul', '', 'chrome,modal', io);
		
		// disable transparent if checkbox checked
		if(io.disable) {
			Zotero.Proxies.autoRecognize = false;
			Zotero.Prefs.set("proxies.autoRecognize", false);
		}
		
		if(io.add) {
			yield proxy.erase();
			yield proxy.save(true);
		}
	 });
	 
	 /**
	  * Get browser and window from a channel
	  * @return	{Object} Object containing the content browser as 'browser' and a ChromeWindow as 'window'
	  */
	function _getBrowserAndWindow(channel) {
		let outerWindowID = channel.loadInfo.outerWindowID;
		var wm = Cc["@mozilla.org/appshell/window-mediator;1"]
			.getService(Ci.nsIWindowMediator);
		let outerContentWin = wm.getOuterWindowWithId(outerWindowID);
		if (!outerContentWin) {
			return { browser: null, window: null };
		}
		var browser = outerContentWin.QueryInterface(Ci.nsIInterfaceRequestor)
			.getInterface(Ci.nsIWebNavigation)
			.QueryInterface(Ci.nsIDocShell).chromeEventHandler;
		return {
			browser,
			window: browser.ownerDocument.defaultView
		};
	}
	 
	 /**
	  * Show a proxy-related notification
	  * @param {Browser} browser
	  * @param {Window} window
	  * @param {String} label - notification text
	  * @param {Object[]} buttons - Array of objects with 'label' (for getString()) and 'callback'
	  */
	 function _showNotification(browser, window, label, buttons) {
		// Get localized button labels
		buttons = buttons.map(function(button) {
			return {
				label: Zotero.getString(button.label),
				callback: button.callback
			}
		});

		var listener = function() {
			var nb = window.gBrowser.getNotificationBox();
			nb.appendNotification(label,
				'zotero-proxy', 'chrome://browser/skin/Info.png', nb.PRIORITY_WARNING_MEDIUM,
				buttons);
			browser.removeEventListener("pageshow", listener, false);
		}
		
		browser.addEventListener("pageshow", listener, false);
	 }

	 /**
		* Disables proxy redirection notification
		*/
	 function _disableRedirectNotification() {
		 Zotero.Proxies.showRedirectNotification = false;
		 Zotero.Prefs.set("proxies.showRedirectNotification",false);
	 }
	 
	 /**
	  * Opens preferences window
	  */
	 function _prefsOpenCallback(window) {
	 	window.openDialog('chrome://zotero/content/preferences/preferences.xul',
			'zotero-prefs',
			'chrome,titlebar,toolbar,'
				+ Zotero.Prefs.get('browser.preferences.instantApply', true) ? 'dialog=no' : 'modal',
			{"pane":"zotero-prefpane-proxies"}
		);
	 }
}

/**
 * Creates a Zotero.Proxy object from a DB row 
 *
 * @constructor
 * @class Represents an individual proxy server
 */
Zotero.Proxy = function (row) {
	this.hosts = [];
	this._loadFromRow(row);
}

/**
 * Loads a proxy object from a DB row
 * @private
 */
Zotero.Proxy.prototype._loadFromRow = function (row) {
	this.proxyID = row.proxyID;
	this.multiHost = row.scheme && row.scheme.indexOf('%h') != -1 || !!row.multiHost;
	this.autoAssociate = !!row.autoAssociate;
	this.scheme = row.scheme;
	// Database query results will throw as this option is only present when the proxy comes along with the translator
	if ('dotsToHyphens' in row) {
		this.dotsToHyphens = !!row.dotsToHyphens;
	}
	
	if (this.scheme) {
		this.compileRegexp();
	}
};

Zotero.Proxy.prototype.toJSON = function() {
	if (!this.scheme) {
		throw Error('Cannot convert proxy to JSON - no scheme');
	}
	return {id: this.id, scheme: this.scheme, dotsToHyphens: this.dotsToHyphens};
}

/**
 * Regexps to match the URL contents corresponding to proxy scheme parameters
 * @const
 */
const Zotero_Proxy_schemeParameters = {
	"%p":"(.*?)",	// path
	"%d":"(.*?)",	// directory
	"%f":"(.*?)",	// filename
	"%a":"(.*?)"	// anything
};

/**
 * Regexps to match proxy scheme parameters in the proxy scheme URL
 * @const
 */
const Zotero_Proxy_schemeParameterRegexps = {
	"%p":/([^%])%p/,
	"%d":/([^%])%d/,
	"%f":/([^%])%f/,
	"%h":/([^%])%h/,
	"%a":/([^%])%a/
};

/**
 * Compiles the regular expression against which we match URLs to determine if this proxy is in use
 * and saves it in this.regexp
 */
Zotero.Proxy.prototype.compileRegexp = function() {
	// take host only if flagged as multiHost
	var parametersToCheck = Zotero_Proxy_schemeParameters;
	if(this.multiHost) parametersToCheck["%h"] = "([a-zA-Z0-9]+[.\\-][a-zA-Z0-9.\\-]+)";
	
	var indices = this.indices = {};
	this.parameters = [];
	for(var param in parametersToCheck) {
		var index = this.scheme.indexOf(param);
		
		// avoid escaped matches
		while(this.scheme[index-1] && (this.scheme[index-1] == "%")) {
			this.scheme = this.scheme.substr(0, index-1)+this.scheme.substr(index);
			index = this.scheme.indexOf(param, index+1);
		}
		
		if(index != -1) {
			this.indices[param] = index;
			this.parameters.push(param);
		}
	}
	
	// sort params by index
	this.parameters = this.parameters.sort(function(a, b) {
		return indices[a]-indices[b];
	})
	
	// now replace with regexp fragment in reverse order
	var re = "^"+Zotero.Utilities.quotemeta(this.scheme)+"$";
	for(var i=this.parameters.length-1; i>=0; i--) {
		var param = this.parameters[i];
		re = re.replace(Zotero_Proxy_schemeParameterRegexps[param], "$1"+parametersToCheck[param]);
	}
	
	this.regexp = new RegExp(re);
}

/**
 * Ensures that the proxy scheme and host settings are valid for this proxy type
 *
 * @returns {String|Boolean} An error type if a validation error occurred, or "false" if there was
 *	no error.
 */
Zotero.Proxy.prototype.validate = function() {
	if(this.scheme.length < 8 || (this.scheme.substr(0, 7) != "http://" && this.scheme.substr(0, 8) != "https://")) {
		return ["scheme.noHTTP"];
	}
	
	if(!this.multiHost && (!this.hosts.length || !this.hosts[0])) {
		return ["host.invalid"];
	} else if(this.multiHost && !Zotero_Proxy_schemeParameterRegexps["%h"].test(this.scheme)) {
		return ["scheme.noHost"];
	}
	
	if(!Zotero_Proxy_schemeParameterRegexps["%p"].test(this.scheme) && 
			(!Zotero_Proxy_schemeParameterRegexps["%d"].test(this.scheme) ||
			!Zotero_Proxy_schemeParameterRegexps["%f"].test(this.scheme))) {
		return ["scheme.noPath"];
	}
	
	if(this.scheme.substr(0, 10) == "http://%h/" || this.scheme.substr(0, 11) == "https://%h/") {
		return ["scheme.invalid"];
	}
	
	for (let host of this.hosts) {
		var oldHost = Zotero.Proxies.hosts[host];
		if(oldHost && oldHost.proxyID && oldHost != this) {
			return ["host.proxyExists", host];
		}
	}
	
	return false;
}

/**
 * Saves any changes to this proxy
 *
 * @param {Boolean} transparent True if proxy should be saved as a persisting, transparent proxy
 */
Zotero.Proxy.prototype.save = Zotero.Promise.coroutine(function* (transparent) {
	// ensure this proxy is valid
	var hasErrors = this.validate();
	if(hasErrors) throw "Proxy: could not be saved because it is invalid: error "+hasErrors[0];
	
	// we never save any changes to non-persisting proxies, so this works
	var newProxy = !this.proxyID;
	
	this.autoAssociate = this.multiHost && this.autoAssociate;
	this.compileRegexp();
	
	if(transparent) {
		yield Zotero.DB.executeTransaction(function* () {
			if(this.proxyID) {
				yield Zotero.DB.queryAsync(
					"UPDATE proxies SET multiHost = ?, autoAssociate = ?, scheme = ? WHERE proxyID = ?",
					[this.multiHost ? 1 : 0, this.autoAssociate ? 1 : 0, this.scheme, this.proxyID]
				);
				yield Zotero.DB.queryAsync("DELETE FROM proxyHosts WHERE proxyID = ?", [this.proxyID]);
			} else {
				let id = Zotero.ID.get('proxies');
				yield Zotero.DB.queryAsync(
					"INSERT INTO proxies (proxyID, multiHost, autoAssociate, scheme) VALUES (?, ?, ?, ?)",
					[id, this.multiHost ? 1 : 0, this.autoAssociate ? 1 : 0, this.scheme]
				);
				this.proxyID = id;
			}
			
			this.hosts = this.hosts.sort();
			var host;
			for(var i in this.hosts) {
				host = this.hosts[i] = this.hosts[i].toLowerCase();
				yield Zotero.DB.queryAsync(
					"INSERT INTO proxyHosts (proxyID, hostname) VALUES (?, ?)",
					[this.proxyID, host]
				);
			}
		}.bind(this));
	}
	
	if(newProxy) {
		Zotero.Proxies.save(this);
	} else {
		Zotero.Proxies.refreshHostMap(this);
		if(!transparent) throw "Proxy: cannot save transparent proxy without transparent param";
	}
});

/**
 * Reverts to the previously saved version of this proxy
 */
Zotero.Proxy.prototype.revert = Zotero.Promise.coroutine(function* () {
	if (!this.proxyID) throw new Error("Cannot revert an unsaved proxy");
	var row = yield Zotero.DB.rowQueryAsync("SELECT * FROM proxies WHERE proxyID = ?", [this.proxyID]);
	this._loadFromRow(row);
	yield this.loadHosts();
});

/**
 * Deletes this proxy
 */
Zotero.Proxy.prototype.erase = Zotero.Promise.coroutine(function* () {
	Zotero.Proxies.remove(this);
	
	if(this.proxyID) {
		yield Zotero.DB.executeTransaction(function* () {
			yield Zotero.DB.queryAsync("DELETE FROM proxyHosts WHERE proxyID = ?", [this.proxyID]);
			yield Zotero.DB.queryAsync("DELETE FROM proxies WHERE proxyID = ?", [this.proxyID]);
		}.bind(this));
	}
});

/**
 * Converts a proxied URL to an unproxied URL using this proxy
 *
 * @param m {String|Array} The URL or the match from running this proxy's regexp against a URL spec
 * @return {String} The unproxified URL if was proxified or the unchanged URL
 */
Zotero.Proxy.prototype.toProper = function(m) {
	if (!Array.isArray(m)) {
		let match = this.regexp.exec(m);
		if (!match) {
			return m
		} else {
			m = match;
		}
	}
	let scheme = this.scheme.indexOf('https') == -1 ? 'http://' : 'https://';
	if(this.multiHost) {
		var properURL = scheme+m[this.parameters.indexOf("%h")+1]+"/";
	} else {
		var properURL = scheme+this.hosts[0]+"/";
	}
	
	// Replace `-` with `.` in https to support EZProxy HttpsHyphens.
	// Potentially troublesome with domains that contain dashes
	if (this.dotsToHyphens) {
		properURL = properURL.replace(/-/g, '.');
	}
	
	if(this.indices["%p"]) {
		properURL += m[this.parameters.indexOf("%p")+1];
	} else {
		var dir = m[this.parameters.indexOf("%d")+1];
		var file = m[this.parameters.indexOf("%f")+1];
		if(dir !== "") properURL += dir+"/";
		properURL += file;
	}
	
	return properURL;
}

/**
 * Converts an unproxied URL to a proxied URL using this proxy
 *
 * @param {String|nsIURI} uri The URL as a string or the nsIURI corresponding to the unproxied URL
 * @return {String} The proxified URL if was unproxified or the unchanged url
 */
Zotero.Proxy.prototype.toProxy = function(uri) {
	if (typeof uri == "string") {
		uri = Services.io.newURI(uri, null, null);
	}
	if (this.regexp.exec(uri.spec)) {
		return uri.spec;
	}
	var proxyURL = this.scheme;
	
	for(var i=this.parameters.length-1; i>=0; i--) {
		var param = this.parameters[i];
		var value = "";
		if(param == "%h") {
			value = this.dotsToHyphens ? uri.hostPort.replace(/-/g, '.') : uri.hostPort;
		} else if(param == "%p") {
			value = uri.path.substr(1);
		} else if(param == "%d") {
			value = uri.path.substr(0, uri.path.lastIndexOf("/"));
		} else if(param == "%f") {
			value = uri.path.substr(uri.path.lastIndexOf("/")+1)
		}
		
		proxyURL = proxyURL.substr(0, this.indices[param])+value+proxyURL.substr(this.indices[param]+2);
	}
	
	return proxyURL;
}

Zotero.Proxy.prototype.loadHosts = Zotero.Promise.coroutine(function* () {
	if (!this.proxyID) {
		throw Error("Cannot load hosts without a proxyID")
	}
	this.hosts = yield Zotero.DB.columnQueryAsync(
		"SELECT hostname FROM proxyHosts WHERE proxyID = ? ORDER BY hostname", this.proxyID
	);
});

/**
 * Detectors for various proxy systems
 * @namespace
 */
Zotero.Proxies.Detectors = new Object();

/**
 * Detector for OCLC EZProxy
 * @param {nsIChannel} channel
 * @type Boolean|Zotero.Proxy
 */
Zotero.Proxies.Detectors.EZProxy = function(channel) {
	// Try to catch links from one proxy-by-port site to another
	if([80, 443, -1].indexOf(channel.URI.port) == -1) {
		// Two options here: we could have a redirect from an EZProxy site to another, or a link
		// If it's a redirect, we'll have to catch the Location: header
		var toProxy = false;
		var fromProxy = false;
		if([301, 302, 303].indexOf(channel.responseStatus) !== -1) {
			try {
				toProxy = Services.io.newURI(channel.getResponseHeader("Location"), null, null);
				fromProxy = channel.URI;
			} catch(e) {}
		} else {
			toProxy = channel.URI;
			fromProxy = channel.referrer;
		}
		
		if(fromProxy && toProxy && fromProxy.host == toProxy.host && fromProxy.port != toProxy.port
				&& [80, 443, -1].indexOf(toProxy.port) == -1) {
			var proxy;
			for (proxy of Zotero.Proxies.proxies) {
				if(proxy.regexp) {
					var m = proxy.regexp.exec(fromProxy.spec);
					if(m) break;
				}
			}
			if(m) {
				// Make sure caught proxy is not multi-host and that we don't have this new proxy already
				if(proxy.multiHost || Zotero.Proxies.proxyToProper(toProxy.spec, true)) return false;
				
				// Create a new nsIObserver and nsIChannel to figure out real URL (by failing to 
				// send cookies, so we get back to the login page)
				var newChannel = Services.io.newChannelFromURI(toProxy);
				newChannel.originalURI = channel.originalURI ? channel.originalURI : channel.URI;
				newChannel.QueryInterface(Components.interfaces.nsIRequest).loadFlags = newChannel.loadFlags;
				Zotero.debug("Proxies: Identified putative port-by-port EZProxy link from "+fromProxy.hostPort+" to "+toProxy.hostPort);
				
				new Zotero.Proxies.Detectors.EZProxy.Observer(newChannel);
				newChannel.asyncOpen(new Zotero.Proxies.Detectors.EZProxy.DummyStreamListener(), null);
				return false;
			}
		}
	}
	
	// Now try to catch redirects
	if(channel.responseStatus != 302) return false;
	try {
		if(channel.getResponseHeader("Server") != "EZproxy") return false;
		var proxiedURI = Services.io.newURI(channel.getResponseHeader("Location"), null, null);
	} catch(e) {
		return false;
	}
	return Zotero.Proxies.Detectors.EZProxy.learn(channel.URI, proxiedURI);
}

/**
 * Learn about a mapping from an EZProxy to a normal proxy
 * @param {nsIURI} loginURI The URL of the login page
 * @param {nsIURI} proxiedURI The URI of the page
 * @return {Zotero.Proxy | false}
 */
Zotero.Proxies.Detectors.EZProxy.learn = function(loginURI, proxiedURI) {
	// look for query
	var m =  /\?(?:.+&)?(url|qurl)=([^&]+)/i.exec(loginURI.path);
	if(!m) return false;
	
	// Ignore if we already know about it
	if(Zotero.Proxies.proxyToProper(proxiedURI.spec, true)) return false;
	
	// Found URL
	var properURL = (m[1].toLowerCase() == "qurl" ? unescape(m[2]) : m[2]);
	var properURI = Services.io.newURI(properURL, null, null);
	
	var proxy = false;
	if(loginURI.host == proxiedURI.host && [loginURI.port, 80, 443, -1].indexOf(proxiedURI.port) == -1) {
		// Proxy by port
		proxy = new Zotero.Proxy();
		proxy.multiHost = false;
		proxy.scheme = proxiedURI.scheme+"://"+proxiedURI.hostPort+"/%p";
		proxy.hosts = [properURI.hostPort];
	} else if(proxiedURI.host != loginURI.host && proxiedURI.hostPort.indexOf(properURI.host) != -1) {
		// Proxy by host
		proxy = new Zotero.Proxy();
		proxy.multiHost = proxy.autoAssociate = true;
		proxy.scheme = proxiedURI.scheme+"://"+proxiedURI.hostPort.replace(properURI.host, "%h")+"/%p";
		proxy.hosts = [properURI.hostPort];
	}
	return proxy;
}

/**
 * @class Do-nothing stream listener
 * @private
 */
Zotero.Proxies.Detectors.EZProxy.DummyStreamListener = function() {}
Zotero.Proxies.Detectors.EZProxy.DummyStreamListener.prototype.onDataAvailable = function(request, 
                                                             context, inputStream, offset, count) {}
Zotero.Proxies.Detectors.EZProxy.DummyStreamListener.prototype.onStartRequest = function(request, context) {}
Zotero.Proxies.Detectors.EZProxy.DummyStreamListener.prototype.onStopRequest = function(request, context, status) {}

/**
 * @class Observer to clear cookies on an HTTP request, then remove itself
 * @private
 */
Zotero.Proxies.Detectors.EZProxy.Observer = function(newChannel) {
	this.channel = newChannel;
	Services.obs.addObserver(this, "http-on-modify-request", false);
	Services.obs.addObserver(this, "http-on-examine-response", false);
}
Zotero.Proxies.Detectors.EZProxy.Observer.prototype.observe = Zotero.Promise.coroutine(function* (aSubject, aTopic, aData) {
	if (aSubject == this.channel) {
		if(aTopic === "http-on-modify-request") {
			try {
				aSubject.QueryInterface(Components.interfaces.nsIHttpChannel).setRequestHeader("Cookie", "", false);
			} catch(e) {
				Zotero.logError(e);
			} finally {
				Services.obs.removeObserver(this, "http-on-modify-request");
			}
		} else if(aTopic === "http-on-examine-response") {
			try {
				// Make sure this is a redirect involving an EZProxy
				if(aSubject.responseStatus !== 302) return;
				try {
					if(aSubject.getResponseHeader("Server") !== "EZproxy") return;
					var loginURL = aSubject.getResponseHeader("Location");
				} catch(e) {
					return;
				}

				var proxy = Zotero.Proxies.Detectors.EZProxy.learn(Services.io.newURI(loginURL, null, null), aSubject.URI);
				if(proxy) {
					Zotero.debug("Proxies: Proxy-by-port EZProxy "+aSubject.URI.hostPort+" corresponds to "+proxy.hosts[0]);
					yield proxy.save();
				}
			} catch(e) {
				Zotero.logError(e);
			} finally {
				Services.obs.removeObserver(this, "http-on-examine-response");
				aSubject.cancel(0x80004004 /*NS_ERROR_ABORT*/);
			}
		}
	}
});
Zotero.Proxies.Detectors.EZProxy.Observer.prototype.QueryInterface = function(aIID) {
	if (aIID.equals(Components.interfaces.nsISupports) ||
		aIID.equals(Components.interfaces.nsIObserver)) return this;
	throw Components.results.NS_NOINTERFACE;
}

/**
 * Detector for Juniper Networks WebVPN
 * @param {nsIChannel} channel
 * @type Boolean|Zotero.Proxy
 */
Zotero.Proxies.Detectors.Juniper = function(channel) {
	const juniperRe = /^(https?:\/\/[^\/:]+(?:\:[0-9]+)?)\/(.*),DanaInfo=([^+,]*)([^+]*)(?:\+(.*))?$/;
	try {
		var url = channel.URI.spec;
		var m = juniperRe.exec(url);
	} catch(e) {
		return false;
	}
	if(!m) return false;
	
	var proxy = new Zotero.Proxy();
	proxy.multiHost = true;
	proxy.autoAssociate = false;
	proxy.scheme = m[1]+"/%d"+",DanaInfo=%h%a+%f";
	proxy.hosts = [m[3]];
	return proxy;
}

Zotero.Proxies.DNS = new function() {
	this.getHostnames = function() {
		if (!Zotero.isWin && !Zotero.isMac && !Zotero.isLinux) return Zotero.Promise.resolve([]);
		var deferred = Zotero.Promise.defer();
		var worker = new ChromeWorker("chrome://zotero/content/xpcom/dns_worker.js");
		Zotero.debug("Proxies.DNS: Performing reverse lookup");
		worker.onmessage = function(e) {
			Zotero.debug("Proxies.DNS: Got hostnames "+e.data);
			deferred.resolve(e.data);
		};
		worker.onerror = function(e) {
			Zotero.debug("Proxies.DNS: Reverse lookup failed");
			deferred.reject(e.message);
		};
		worker.postMessage(Zotero.isWin ? "win" : Zotero.isMac ? "mac" : Zotero.isLinux ? "linux" : "unix");
		return deferred.promise;
	}
};