/**
 * Retold Remote Native Bridge
 *
 * This script loads before the retold-remote web application and provides:
 * 1. Platform detection (Tauri desktop / Capacitor iOS)
 * 2. Connection screen for selecting a server
 * 3. URL rewriting to redirect API/content requests to the configured server
 * 4. Media interception to launch native video/audio players
 *
 * It keeps the retold-remote web app completely unmodified.
 */
(function ()
{
	'use strict';

	// ---- Platform detection ----
	window.__RETOLD_NATIVE__ =
	{
		isTauri: false,
		isCapacitor: false,
		isIOS: false,
		platform: 'unknown'
	};

	// Tauri detection (window.__TAURI__ is set by Tauri's IPC injection)
	if (typeof window.__TAURI_INTERNALS__ !== 'undefined' || typeof window.__TAURI__ !== 'undefined')
	{
		window.__RETOLD_NATIVE__.isTauri = true;
		window.__RETOLD_NATIVE__.platform = 'desktop';
	}
	// Capacitor detection
	else if (typeof window.Capacitor !== 'undefined')
	{
		window.__RETOLD_NATIVE__.isCapacitor = true;
		window.__RETOLD_NATIVE__.isIOS = (window.Capacitor.getPlatform && window.Capacitor.getPlatform() === 'ios');
		window.__RETOLD_NATIVE__.platform = window.__RETOLD_NATIVE__.isIOS ? 'ios' : 'mobile';
	}

	// ---- Server URL management ----
	var STORAGE_KEY_SERVER_URL = 'retold-native-server-url';
	var STORAGE_KEY_SAVED_SERVERS = 'retold-native-saved-servers';

	window.__RETOLD_SERVER_URL__ = '';

	function _getSavedServerURL()
	{
		try
		{
			return localStorage.getItem(STORAGE_KEY_SERVER_URL) || '';
		}
		catch (pErr)
		{
			return '';
		}
	}

	function _saveServerURL(pURL)
	{
		try
		{
			localStorage.setItem(STORAGE_KEY_SERVER_URL, pURL);
			_addToSavedServers(pURL);
		}
		catch (pErr)
		{
			// localStorage may not be available
		}
	}

	function _getSavedServers()
	{
		try
		{
			var tmpRaw = localStorage.getItem(STORAGE_KEY_SAVED_SERVERS);
			return tmpRaw ? JSON.parse(tmpRaw) : [];
		}
		catch (pErr)
		{
			return [];
		}
	}

	function _addToSavedServers(pURL)
	{
		try
		{
			var tmpServers = _getSavedServers();
			// Remove duplicates
			tmpServers = tmpServers.filter(function (pEntry) { return pEntry.url !== pURL; });
			// Add to front
			tmpServers.unshift({ url: pURL, lastUsed: new Date().toISOString() });
			// Keep at most 10
			if (tmpServers.length > 10)
			{
				tmpServers = tmpServers.slice(0, 10);
			}
			localStorage.setItem(STORAGE_KEY_SAVED_SERVERS, JSON.stringify(tmpServers));
		}
		catch (pErr)
		{
			// ignore
		}
	}

	function _removeFromSavedServers(pURL)
	{
		try
		{
			var tmpServers = _getSavedServers();
			tmpServers = tmpServers.filter(function (pEntry) { return pEntry.url !== pURL; });
			localStorage.setItem(STORAGE_KEY_SAVED_SERVERS, JSON.stringify(tmpServers));
		}
		catch (pErr)
		{
			// ignore
		}
	}

	// ---- URL rewriting ----
	// Tauri proxy — calls Rust proxy_fetch command via IPC, bypasses CORS entirely
	function _tauriInvoke(pCommand, pArgs)
	{
		if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
		{
			return window.__TAURI__.core.invoke(pCommand, pArgs);
		}
		if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke)
		{
			return window.__TAURI_INTERNALS__.invoke(pCommand, pArgs);
		}
		return Promise.reject(new Error('Tauri invoke not available'));
	}

	// Creates a Headers-like wrapper around a plain {key:value} object
	// so that response.headers.get('X-Custom-Header') works correctly
	function _makeHeaders(pHeadersObj)
	{
		var tmpRaw = pHeadersObj || {};
		return {
			get: function (pName)
			{
				var tmpLower = pName.toLowerCase();
				for (var tmpKey in tmpRaw)
				{
					if (tmpRaw.hasOwnProperty(tmpKey) && tmpKey.toLowerCase() === tmpLower)
					{
						return tmpRaw[tmpKey];
					}
				}
				return null;
			},
			has: function (pName)
			{
				var tmpLower = pName.toLowerCase();
				for (var tmpKey in tmpRaw)
				{
					if (tmpRaw.hasOwnProperty(tmpKey) && tmpKey.toLowerCase() === tmpLower)
					{
						return true;
					}
				}
				return false;
			},
			forEach: function (pCallback)
			{
				for (var tmpKey in tmpRaw)
				{
					if (tmpRaw.hasOwnProperty(tmpKey))
					{
						pCallback(tmpRaw[tmpKey], tmpKey, this);
					}
				}
			},
			entries: function ()
			{
				var tmpEntries = [];
				for (var tmpKey in tmpRaw)
				{
					if (tmpRaw.hasOwnProperty(tmpKey))
					{
						tmpEntries.push([tmpKey, tmpRaw[tmpKey]]);
					}
				}
				return tmpEntries;
			}
		};
	}

	// Wraps the Rust proxy_fetch result as a fetch-like Response object
	function _proxyFetch(pURL, pOptions)
	{
		var tmpMethod = (pOptions && pOptions.method) ? pOptions.method : 'GET';
		var tmpBody = (pOptions && pOptions.body) ? pOptions.body : null;

		// Forward request headers (e.g. Content-Type: application/json)
		var tmpRequestHeaders = null;
		if (pOptions && pOptions.headers)
		{
			tmpRequestHeaders = {};
			if (pOptions.headers instanceof Headers)
			{
				pOptions.headers.forEach(function (pValue, pKey) { tmpRequestHeaders[pKey] = pValue; });
			}
			else if (typeof pOptions.headers === 'object')
			{
				for (var tmpKey in pOptions.headers)
				{
					if (pOptions.headers.hasOwnProperty(tmpKey))
					{
						tmpRequestHeaders[tmpKey] = pOptions.headers[tmpKey];
					}
				}
			}
		}

		return _tauriInvoke('proxy_fetch', {
			url: pURL,
			method: tmpMethod,
			body: tmpBody,
			headers: tmpRequestHeaders
		}).then(function (pResult)
		{
			// pResult = { status, headers, body }
			var tmpResponseHeaders = _makeHeaders(pResult.headers);
			var tmpResponseBody = pResult.body;
			var tmpStatus = pResult.status;

			var tmpResponse = {
				ok: tmpStatus >= 200 && tmpStatus < 300,
				status: tmpStatus,
				statusText: '',
				headers: tmpResponseHeaders,
				url: pURL,
				type: 'basic',
				redirected: false,
				json: function () {
					try
					{
						return Promise.resolve(JSON.parse(tmpResponseBody));
					}
					catch (pErr)
					{
						return Promise.reject(new SyntaxError('JSON parse error: ' + pErr.message));
					}
				},
				text: function () { return Promise.resolve(tmpResponseBody); },
				blob: function () { return Promise.resolve(new Blob([tmpResponseBody])); },
				arrayBuffer: function ()
				{
					var tmpEncoder = new TextEncoder();
					return Promise.resolve(tmpEncoder.encode(tmpResponseBody).buffer);
				},
				clone: function () { return Object.assign({}, tmpResponse); },
				body: tmpResponseBody
			};

			return tmpResponse;
		});
	}

	function _shouldRewriteURL(pURL)
	{
		if (typeof pURL !== 'string') return false;
		if (!window.__RETOLD_SERVER_URL__) return false;
		return (pURL.startsWith('/api/') ||
				pURL.startsWith('/content/') ||
				pURL.startsWith('/content-hashed/'));
	}

	function _isServerURL(pURL)
	{
		if (typeof pURL !== 'string') return false;
		if (!window.__RETOLD_SERVER_URL__) return false;
		return pURL.startsWith(window.__RETOLD_SERVER_URL__);
	}

	function _rewriteURL(pURL)
	{
		if (_shouldRewriteURL(pURL))
		{
			return window.__RETOLD_SERVER_URL__ + pURL;
		}
		return pURL;
	}

	function _installURLRewriting()
	{
		// Patch fetch() — use Tauri proxy for server requests (bypasses CORS)
		var tmpOriginalFetch = window.fetch;
		window.fetch = function (pURL, pOptions)
		{
			var tmpResolvedURL = pURL;
			if (typeof pURL === 'string')
			{
				tmpResolvedURL = _rewriteURL(pURL);
			}
			else if (pURL instanceof Request && _shouldRewriteURL(pURL.url))
			{
				tmpResolvedURL = new Request(_rewriteURL(pURL.url), pURL);
			}

			// Use Tauri proxy for cross-origin server requests (bypasses CORS)
			if (window.__RETOLD_NATIVE__.isTauri)
			{
				var tmpURL = (typeof tmpResolvedURL === 'string') ? tmpResolvedURL :
					(tmpResolvedURL instanceof Request) ? tmpResolvedURL.url : null;
				if (tmpURL && _isServerURL(tmpURL))
				{
					console.log('[RetoldBridge] Proxying fetch:', tmpURL);
					return _proxyFetch(tmpURL, pOptions)
						.then(function (pResponse)
						{
							console.log('[RetoldBridge] Proxy response:', tmpURL, 'status:', pResponse.status);
							return pResponse;
						})
						.catch(function (pError)
						{
							console.error('[RetoldBridge] Proxy fetch error:', tmpURL, pError);
							throw pError;
						});
				}
			}

			return tmpOriginalFetch.call(this, tmpResolvedURL, pOptions);
		};

		// Patch XMLHttpRequest.open() — rewrite URLs
		var tmpOriginalXHROpen = XMLHttpRequest.prototype.open;
		XMLHttpRequest.prototype.open = function (pMethod, pURL)
		{
			if (typeof pURL === 'string')
			{
				pURL = _rewriteURL(pURL);
			}
			// Store resolved URL so send() can redirect through Tauri proxy if needed
			this._retoldResolvedURL = pURL;
			this._retoldMethod = pMethod;
			var tmpArgs = Array.prototype.slice.call(arguments);
			tmpArgs[1] = pURL;
			return tmpOriginalXHROpen.apply(this, tmpArgs);
		};

		// Patch XMLHttpRequest.send() — for server URLs, use Tauri proxy
		var tmpOriginalXHRSend = XMLHttpRequest.prototype.send;

		// Also capture setRequestHeader calls for XHR requests
		var tmpOriginalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
		XMLHttpRequest.prototype.setRequestHeader = function (pName, pValue)
		{
			if (!this._retoldHeaders)
			{
				this._retoldHeaders = {};
			}
			this._retoldHeaders[pName] = pValue;
			return tmpOriginalSetRequestHeader.apply(this, arguments);
		};

		XMLHttpRequest.prototype.send = function (pBody)
		{
			var tmpSelf = this;
			if (window.__RETOLD_NATIVE__.isTauri && tmpSelf._retoldResolvedURL && _isServerURL(tmpSelf._retoldResolvedURL))
			{
				// Route through Tauri's CORS-free Rust HTTP client
				var tmpOptions = {
					method: tmpSelf._retoldMethod || 'GET',
					body: pBody || null
				};
				if (tmpSelf._retoldHeaders)
				{
					tmpOptions.headers = tmpSelf._retoldHeaders;
				}

				_proxyFetch(tmpSelf._retoldResolvedURL, tmpOptions)
					.then(function (pResponse)
					{
						// Store proxy response data on hidden properties
						// (native XHR properties are read-only getters, cannot be overridden)
						tmpSelf._retoldProxyResponse = pResponse;
						tmpSelf._retoldProxyStatus = pResponse.status;
						tmpSelf._retoldProxyStatusText = pResponse.statusText || '';
						tmpSelf._retoldProxyResponseText = pResponse.body || '';
						tmpSelf._retoldProxyReadyState = 4;

						if (typeof tmpSelf.onreadystatechange === 'function')
						{
							tmpSelf.onreadystatechange();
						}
						if (typeof tmpSelf.onload === 'function')
						{
							tmpSelf.onload();
						}
						try { tmpSelf.dispatchEvent(new Event('load')); } catch (e) { /* ignore */ }
					})
					.catch(function (pError)
					{
						tmpSelf._retoldProxyStatus = 0;
						tmpSelf._retoldProxyReadyState = 4;
						if (typeof tmpSelf.onerror === 'function')
						{
							tmpSelf.onerror(pError);
						}
						try { tmpSelf.dispatchEvent(new Event('error')); } catch (e) { /* ignore */ }
					});
				return;
			}
			return tmpOriginalXHRSend.apply(this, arguments);
		};

		// Patch HTMLImageElement.prototype.src setter to rewrite URLs at assignment time.
		// This is critical for libraries like OpenSeadragon that create Image objects
		// off-DOM (new Image(); img.src = url) where MutationObserver can't intercept.
		// _rewriteURL returns the original URL unchanged for non-matching patterns,
		// and already-rewritten URLs won't match _shouldRewriteURL, so double-rewrite is safe.
		var tmpOrigSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
		if (tmpOrigSrcDescriptor && tmpOrigSrcDescriptor.set)
		{
			Object.defineProperty(HTMLImageElement.prototype, 'src', {
				set: function (pValue)
				{
					tmpOrigSrcDescriptor.set.call(this, _rewriteURL(pValue));
				},
				get: tmpOrigSrcDescriptor.get,
				enumerable: tmpOrigSrcDescriptor.enumerable,
				configurable: true
			});
		}

		// MutationObserver to rewrite src attributes on dynamically added elements
		var tmpObserver = new MutationObserver(function (pMutations)
		{
			for (var i = 0; i < pMutations.length; i++)
			{
				var tmpMutation = pMutations[i];
				for (var j = 0; j < tmpMutation.addedNodes.length; j++)
				{
					var tmpNode = tmpMutation.addedNodes[j];
					if (tmpNode.nodeType !== 1) continue; // Element nodes only

					// Check the node itself
					_rewriteElementSrc(tmpNode);

					// Check children
					if (tmpNode.querySelectorAll)
					{
						var tmpElements = tmpNode.querySelectorAll('[src]');
						for (var k = 0; k < tmpElements.length; k++)
						{
							_rewriteElementSrc(tmpElements[k]);
						}
					}
				}
			}
		});

		// Start observing once body exists
		function _startObserving()
		{
			if (document.body)
			{
				tmpObserver.observe(document.body, { childList: true, subtree: true });
			}
			else
			{
				setTimeout(_startObserving, 50);
			}
		}
		_startObserving();
	}

	function _rewriteElementSrc(pElement)
	{
		if (!pElement || !pElement.getAttribute) return;
		var tmpSrc = pElement.getAttribute('src');
		if (tmpSrc && _shouldRewriteURL(tmpSrc))
		{
			pElement.setAttribute('src', _rewriteURL(tmpSrc));
		}
	}

	// ---- Connection screen ----
	function _showConnectionScreen()
	{
		// Block the app from loading until we have a server URL
		window.__RETOLD_BRIDGE_BLOCKING__ = true;

		var tmpSavedServers = _getSavedServers();
		var tmpServerListHTML = '';

		if (tmpSavedServers.length > 0)
		{
			tmpServerListHTML = '<div class="retold-bridge-saved-servers">';
			tmpServerListHTML += '<div class="retold-bridge-section-title">Recent Servers</div>';
			for (var i = 0; i < tmpSavedServers.length; i++)
			{
				var tmpServer = tmpSavedServers[i];
				tmpServerListHTML += '<div class="retold-bridge-server-entry" data-url="' + tmpServer.url + '">';
				tmpServerListHTML += '<button class="retold-bridge-server-btn" onclick="window.__retoldBridge_connectToServer(\'' + tmpServer.url.replace(/'/g, "\\'") + '\')">';
				tmpServerListHTML += tmpServer.url;
				tmpServerListHTML += '</button>';
				tmpServerListHTML += '<button class="retold-bridge-server-remove" onclick="window.__retoldBridge_removeServer(\'' + tmpServer.url.replace(/'/g, "\\'") + '\')" title="Remove">&times;</button>';
				tmpServerListHTML += '</div>';
			}
			tmpServerListHTML += '</div>';
		}

		var tmpLocalFolderHTML = '';
		if (window.__RETOLD_NATIVE__.isTauri)
		{
			tmpLocalFolderHTML = '<div class="retold-bridge-divider"><span>or</span></div>';
			tmpLocalFolderHTML += '<button class="retold-bridge-local-btn" onclick="window.__retoldBridge_openLocalFolder()">';
			tmpLocalFolderHTML += 'Open Local Folder';
			tmpLocalFolderHTML += '</button>';
		}

		var tmpOverlay = document.createElement('div');
		tmpOverlay.id = 'RetoldBridge-ConnectionScreen';
		tmpOverlay.className = 'retold-bridge-overlay';
		tmpOverlay.innerHTML =
			'<div class="retold-bridge-dialog">' +
				'<div class="retold-bridge-logo">Retold Remote</div>' +
				'<div class="retold-bridge-subtitle">Connect to a server</div>' +
				'<div class="retold-bridge-form">' +
					'<input type="text" id="RetoldBridge-ServerURL" class="retold-bridge-input" ' +
						'placeholder="http://nas.local:7500" ' +
						'autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" />' +
					'<button class="retold-bridge-connect-btn" id="RetoldBridge-ConnectBtn" onclick="window.__retoldBridge_connect()">Connect</button>' +
				'</div>' +
				'<div id="RetoldBridge-Status" class="retold-bridge-status"></div>' +
				tmpServerListHTML +
				tmpLocalFolderHTML +
			'</div>';

		document.body.appendChild(tmpOverlay);

		// Focus the input
		var tmpInput = document.getElementById('RetoldBridge-ServerURL');
		if (tmpInput)
		{
			tmpInput.focus();
			tmpInput.addEventListener('keydown', function (pEvent)
			{
				if (pEvent.key === 'Enter')
				{
					window.__retoldBridge_connect();
				}
			});
		}
	}

	function _setStatus(pMessage, pIsError)
	{
		var tmpStatus = document.getElementById('RetoldBridge-Status');
		if (tmpStatus)
		{
			tmpStatus.textContent = pMessage;
			tmpStatus.className = 'retold-bridge-status' + (pIsError ? ' retold-bridge-status-error' : '');
		}
	}

	function _hideConnectionScreen()
	{
		var tmpOverlay = document.getElementById('RetoldBridge-ConnectionScreen');
		if (tmpOverlay)
		{
			tmpOverlay.remove();
		}
		window.__RETOLD_BRIDGE_BLOCKING__ = false;
	}

	// ---- CORS-free fetch helper ----
	// Uses Tauri proxy_fetch command when available, otherwise native fetch
	function _corsFetch(pURL, pOptions)
	{
		if (window.__RETOLD_NATIVE__.isTauri)
		{
			return _proxyFetch(pURL, pOptions);
		}
		return window.fetch(pURL, pOptions);
	}

	// ---- Global connection functions (called from HTML onclick) ----
	window.__retoldBridge_connect = function ()
	{
		var tmpInput = document.getElementById('RetoldBridge-ServerURL');
		if (!tmpInput) return;
		var tmpURL = tmpInput.value.trim();
		if (!tmpURL) return;

		// Normalize: remove trailing slash
		tmpURL = tmpURL.replace(/\/+$/, '');

		// Add protocol if missing
		if (!tmpURL.match(/^https?:\/\//))
		{
			tmpURL = 'http://' + tmpURL;
		}

		_setStatus('Connecting...');

		// Test the connection by fetching capabilities (CORS-free)
		_corsFetch(tmpURL + '/api/media/capabilities')
			.then(function (pResponse)
			{
				if (!pResponse.ok) throw new Error('Server returned ' + pResponse.status);
				return pResponse.json();
			})
			.then(function (pData)
			{
				if (pData && pData.Capabilities !== undefined)
				{
					_activateServer(tmpURL);
				}
				else
				{
					_setStatus('Not a retold-remote server', true);
				}
			})
			.catch(function (pError)
			{
				_setStatus('Could not connect: ' + pError.message, true);
			});
	};

	window.__retoldBridge_connectToServer = function (pURL)
	{
		_setStatus('Connecting...');

		_corsFetch(pURL + '/api/media/capabilities')
			.then(function (pResponse)
			{
				if (!pResponse.ok) throw new Error('Server returned ' + pResponse.status);
				return pResponse.json();
			})
			.then(function ()
			{
				_activateServer(pURL);
			})
			.catch(function (pError)
			{
				_setStatus('Could not connect: ' + pError.message, true);
			});
	};

	window.__retoldBridge_removeServer = function (pURL)
	{
		_removeFromSavedServers(pURL);
		// Remove the entry from the DOM
		var tmpEntries = document.querySelectorAll('.retold-bridge-server-entry');
		for (var i = 0; i < tmpEntries.length; i++)
		{
			if (tmpEntries[i].getAttribute('data-url') === pURL)
			{
				tmpEntries[i].remove();
				break;
			}
		}
	};

	window.__retoldBridge_openLocalFolder = function ()
	{
		if (!window.__RETOLD_NATIVE__.isTauri) return;

		// Use the global __TAURI__ APIs (available via withGlobalTauri: true)
		try
		{
			var tmpDialogAPI = window.__TAURI__ && window.__TAURI__.dialog;
			if (!tmpDialogAPI || !tmpDialogAPI.open)
			{
				_setStatus('Dialog API not available', true);
				return;
			}

			tmpDialogAPI.open({ directory: true, title: 'Select media folder' })
				.then(function (tmpFolder)
				{
					if (!tmpFolder) return;

					_setStatus('Starting server...');

					return _tauriInvoke('start_server', { contentPath: tmpFolder })
						.then(function (tmpResult)
						{
							var tmpURL = 'http://localhost:' + tmpResult.port;
							_activateServer(tmpURL);
						});
				})
				.catch(function (pError)
				{
					_setStatus('Failed to start server: ' + pError, true);
				});
		}
		catch (pError)
		{
			_setStatus('Failed to open folder dialog: ' + pError, true);
		}
	};

	window.__retoldBridge_disconnect = function ()
	{
		window.__RETOLD_SERVER_URL__ = '';
		_showConnectionScreen();
	};

	function _activateServer(pURL)
	{
		window.__RETOLD_SERVER_URL__ = pURL;
		_saveServerURL(pURL);
		_hideConnectionScreen();

		// Load the retold-remote application
		_loadApplication();
	}

	// ---- Application loading ----
	function _loadApplication()
	{
		// The app scripts load via HTML script tags regardless of the bridge state.
		// If the app already initialized (made API calls with no server URL),
		// the simplest fix is to reload so all API calls go through the proxy.
		// Check for either the Pict global or the app instance.
		if (typeof Pict !== 'undefined' || typeof pict !== 'undefined')
		{
			// Force reload — simplest way to reinitialize with new server URL
			location.reload();
			return;
		}

		// The app scripts are already in the HTML, they just need to fire.
		// If we blocked loading, trigger it now.
		if (window.__RETOLD_BRIDGE_DEFERRED_INIT__)
		{
			window.__RETOLD_BRIDGE_DEFERRED_INIT__();
		}
	}

	// ---- Media interception ----
	var _mediaInterceptionInstalled = false;
	function _installMediaInterception()
	{
		// Guard against double-patching (which creates duplicate buttons)
		if (_mediaInterceptionInstalled) return;
		_mediaInterceptionInstalled = true;

		// Wait for the pict application to be fully initialized
		var tmpCheckInterval = setInterval(function ()
		{
			if (typeof pict === 'undefined' || !pict.views || !pict.views['RetoldRemote-MediaViewer'])
			{
				return;
			}
			clearInterval(tmpCheckInterval);

			var tmpMediaViewer = pict.views['RetoldRemote-MediaViewer'];

			// Store original _buildVideoHTML
			var tmpOriginalBuildVideoHTML = tmpMediaViewer._buildVideoHTML.bind(tmpMediaViewer);

			// Patch _buildVideoHTML to add "Play with mpv" button
			tmpMediaViewer._buildVideoHTML = function (pURL, pFileName)
			{
				var tmpHTML = tmpOriginalBuildVideoHTML(pURL, pFileName);

				// Add native player button before the closing </div>
				var tmpNativeBtn = '<button class="retold-remote-video-action-btn" '
					+ 'onclick="window.__retoldBridge_playNativeVideo()" '
					+ 'title="Play with native player (full codec support)">'
					+ '<span class="retold-remote-video-action-key">n</span>'
					+ 'Play with Native Player'
					+ '</button>';

				// Insert before the last </div>
				tmpHTML = tmpHTML.replace(/<\/div>\s*$/, tmpNativeBtn + '</div>');

				return tmpHTML;
			};

			// Listen for 'n' key in viewer mode to trigger native playback
			var tmpOriginalHandleKey = null;
			if (pict.providers['RetoldRemote-GalleryNavigation'] &&
				pict.providers['RetoldRemote-GalleryNavigation']._keyHandlers &&
				pict.providers['RetoldRemote-GalleryNavigation']._keyHandlers.viewer)
			{
				var tmpViewerHandler = pict.providers['RetoldRemote-GalleryNavigation']._keyHandlers.viewer;
				tmpOriginalHandleKey = tmpViewerHandler.handleKey;
				tmpViewerHandler.handleKey = function (pEvent)
				{
					if (pEvent.key === 'n' && pict.AppData.RetoldRemote.CurrentViewerMediaType === 'video')
					{
						window.__retoldBridge_playNativeVideo();
						return true;
					}
					if (tmpOriginalHandleKey)
					{
						return tmpOriginalHandleKey.call(this, pEvent);
					}
				};
			}
		}, 200);
	}

	// ---- Native player overlay and keyboard controls ----
	var _nativePlayerStatusInterval = null;

	function _formatTime(pSeconds)
	{
		if (typeof pSeconds !== 'number' || isNaN(pSeconds)) return '--:--';
		var tmpSeconds = Math.floor(pSeconds);
		var tmpHours = Math.floor(tmpSeconds / 3600);
		var tmpMinutes = Math.floor((tmpSeconds % 3600) / 60);
		var tmpSecs = tmpSeconds % 60;
		if (tmpHours > 0)
		{
			return tmpHours + ':' + (tmpMinutes < 10 ? '0' : '') + tmpMinutes + ':' + (tmpSecs < 10 ? '0' : '') + tmpSecs;
		}
		return tmpMinutes + ':' + (tmpSecs < 10 ? '0' : '') + tmpSecs;
	}

	function _showNativePlayerOverlay(pTitle)
	{
		// Remove any existing overlay
		_hideNativePlayerOverlay();

		var tmpOverlay = document.createElement('div');
		tmpOverlay.id = 'RetoldBridge-NativePlayer';
		tmpOverlay.className = 'retold-native-player-bar';
		tmpOverlay.innerHTML =
			'<div class="retold-native-player-inner">' +
				'<div class="retold-native-player-title" id="RetoldBridge-NP-Title">' + (pTitle || 'Playing') + '</div>' +
				'<div class="retold-native-player-status">' +
					'<span id="RetoldBridge-NP-Status">Loading...</span>' +
					'<span id="RetoldBridge-NP-Time"></span>' +
				'</div>' +
				'<div class="retold-native-player-keys">' +
					'<span class="retold-native-player-key">Space</span> pause' +
					' <span class="retold-native-player-sep">|</span> ' +
					'<span class="retold-native-player-key">&larr;&rarr;</span> seek' +
					' <span class="retold-native-player-sep">|</span> ' +
					'<span class="retold-native-player-key">&uarr;&darr;</span> volume' +
					' <span class="retold-native-player-sep">|</span> ' +
					'<span class="retold-native-player-key">m</span> mute' +
					' <span class="retold-native-player-sep">|</span> ' +
					'<span class="retold-native-player-key">f</span> fullscreen' +
					' <span class="retold-native-player-sep">|</span> ' +
					'<span class="retold-native-player-key">[ ]</span> speed' +
					' <span class="retold-native-player-sep">|</span> ' +
					'<span class="retold-native-player-key">q</span> quit' +
				'</div>' +
			'</div>';

		document.body.appendChild(tmpOverlay);

		// Start polling mpv status
		_nativePlayerStatusInterval = setInterval(_pollNativePlayerStatus, 500);
	}

	function _hideNativePlayerOverlay()
	{
		var tmpOverlay = document.getElementById('RetoldBridge-NativePlayer');
		if (tmpOverlay)
		{
			tmpOverlay.classList.add('retold-native-player-bar-hiding');
			setTimeout(function ()
			{
				if (tmpOverlay.parentNode) tmpOverlay.parentNode.removeChild(tmpOverlay);
			}, 300);
		}

		if (_nativePlayerStatusInterval)
		{
			clearInterval(_nativePlayerStatusInterval);
			_nativePlayerStatusInterval = null;
		}
	}

	function _pollNativePlayerStatus()
	{
		if (!window.__RETOLD_NATIVE__.mpvPlaying) return;

		_tauriInvoke('mpv_get_status', {})
			.then(function (pStatus)
			{
				if (!pStatus.playing)
				{
					// mpv has exited
					window.__RETOLD_NATIVE__.mpvPlaying = false;
					_hideNativePlayerOverlay();
					return;
				}

				var tmpStatusEl = document.getElementById('RetoldBridge-NP-Status');
				var tmpTimeEl = document.getElementById('RetoldBridge-NP-Time');
				if (!tmpStatusEl || !tmpTimeEl) return;

				// Build status text
				var tmpParts = [];
				if (pStatus.paused === true)
				{
					tmpParts.push('Paused');
				}
				else
				{
					tmpParts.push('Playing');
				}
				if (typeof pStatus.volume === 'number')
				{
					tmpParts.push('Vol: ' + Math.round(pStatus.volume) + '%');
				}
				if (typeof pStatus.speed === 'number' && Math.abs(pStatus.speed - 1.0) > 0.01)
				{
					tmpParts.push(pStatus.speed.toFixed(1) + 'x');
				}
				tmpStatusEl.textContent = tmpParts.join('  ');

				// Build time display
				if (typeof pStatus.position === 'number' && typeof pStatus.duration === 'number')
				{
					tmpTimeEl.textContent = _formatTime(pStatus.position) + ' / ' + _formatTime(pStatus.duration);
				}
				else if (typeof pStatus.position === 'number')
				{
					tmpTimeEl.textContent = _formatTime(pStatus.position);
				}
				else
				{
					tmpTimeEl.textContent = '';
				}
			})
			.catch(function ()
			{
				// Socket may not be ready yet or mpv exited
			});
	}

	function _nativePlayerKeyHandler(pEvent)
	{
		if (!window.__RETOLD_NATIVE__.mpvPlaying) return;

		var tmpCommand = null;

		switch (pEvent.key)
		{
			case ' ':
				tmpCommand = 'toggle-pause';
				break;
			case 'ArrowRight':
				tmpCommand = pEvent.shiftKey ? 'seek-forward-large' : 'seek-forward';
				break;
			case 'ArrowLeft':
				tmpCommand = pEvent.shiftKey ? 'seek-backward-large' : 'seek-backward';
				break;
			case 'ArrowUp':
				tmpCommand = 'volume-up';
				break;
			case 'ArrowDown':
				tmpCommand = 'volume-down';
				break;
			case 'm':
				tmpCommand = 'toggle-mute';
				break;
			case 'f':
				tmpCommand = 'toggle-fullscreen';
				break;
			case '[':
				tmpCommand = 'speed-down';
				break;
			case ']':
				tmpCommand = 'speed-up';
				break;
			case 'Backspace':
				tmpCommand = 'speed-reset';
				break;
			case 'q':
			case 'Escape':
				tmpCommand = 'stop';
				break;
			default:
				return; // Don't intercept unrecognized keys
		}

		// Prevent retold-remote's key handlers from firing
		pEvent.preventDefault();
		pEvent.stopPropagation();

		_tauriInvoke('mpv_control', { command: tmpCommand })
			.then(function ()
			{
				if (tmpCommand === 'stop')
				{
					window.__RETOLD_NATIVE__.mpvPlaying = false;
					_hideNativePlayerOverlay();
				}
			})
			.catch(function (pError)
			{
				console.error('[RetoldBridge] mpv control error:', pError);
			});
	}

	// Register keyboard handler on capture phase (fires before retold-remote's handlers)
	document.addEventListener('keydown', _nativePlayerKeyHandler, true);

	// ---- Native playback launch functions ----

	function _launchNativePlayer(pURL, pTitle)
	{
		if (window.__RETOLD_NATIVE__.isTauri)
		{
			_tauriInvoke('mpv_play', { url: pURL, title: pTitle })
				.then(function ()
				{
					window.__RETOLD_NATIVE__.mpvPlaying = true;
					_showNativePlayerOverlay(pTitle);
				})
				.catch(function (pError)
				{
					console.error('[RetoldBridge] Native playback failed:', pError);
					// Fall back to browser playback for video
					if (typeof pict !== 'undefined' && pict.views['RetoldRemote-MediaViewer'] && pict.views['RetoldRemote-MediaViewer'].playVideo)
					{
						pict.views['RetoldRemote-MediaViewer'].playVideo();
					}
				});
		}
		else if (window.__RETOLD_NATIVE__.isCapacitor)
		{
			try
			{
				var tmpNativePlayer = window.RetoldNativePlayer;
				if (tmpNativePlayer)
				{
					tmpNativePlayer.playVideo({ url: pURL, title: pTitle });
				}
			}
			catch (pError)
			{
				console.error('[RetoldBridge] Native playback failed:', pError);
			}
		}
	}

	window.__retoldBridge_playNativeVideo = function ()
	{
		if (typeof pict === 'undefined') return;

		var tmpRemote = pict.AppData.RetoldRemote;
		var tmpFilePath = tmpRemote.CurrentViewerFile;
		if (!tmpFilePath) return;

		var tmpProvider = pict.providers['RetoldRemote-Provider'];
		var tmpContentURL = tmpProvider ? tmpProvider.getContentURL(tmpFilePath) : ('/content/' + encodeURIComponent(tmpFilePath));
		var tmpFullURL = _rewriteURL(tmpContentURL);
		var tmpFileName = tmpFilePath.replace(/^.*\//, '');

		_launchNativePlayer(tmpFullURL, tmpFileName);
	};

	window.__retoldBridge_playNativeAudio = function ()
	{
		if (typeof pict === 'undefined') return;

		var tmpRemote = pict.AppData.RetoldRemote;
		var tmpFilePath = tmpRemote.CurrentViewerFile;
		if (!tmpFilePath) return;

		var tmpProvider = pict.providers['RetoldRemote-Provider'];
		var tmpContentURL = tmpProvider ? tmpProvider.getContentURL(tmpFilePath) : ('/content/' + encodeURIComponent(tmpFilePath));
		var tmpFullURL = _rewriteURL(tmpContentURL);
		var tmpFileName = tmpFilePath.replace(/^.*\//, '');

		_launchNativePlayer(tmpFullURL, tmpFileName);
	};

	// ---- Initialization ----

	// CRITICAL: Install URL rewriting and set server URL IMMEDIATELY
	// (not deferred to DOMContentLoaded) so that when retold-remote's scripts
	// execute and call fetchCapabilities() during parsing, the patched fetch()
	// and __RETOLD_SERVER_URL__ are already in place.
	_installURLRewriting();

	var _savedURL = _getSavedServerURL();
	if (_savedURL)
	{
		window.__RETOLD_SERVER_URL__ = _savedURL;
	}

	// DOM-dependent initialization (connection screen, server verification)
	function _initDOM()
	{
		if (_savedURL)
		{
			// Verify the saved server is still reachable (non-blocking, CORS-free)
			_corsFetch(_savedURL + '/api/media/capabilities')
				.then(function (pResponse)
				{
					if (!pResponse.ok) throw new Error('unreachable');
					return pResponse.json();
				})
				.then(function ()
				{
					// Server is up — all good
				})
				.catch(function ()
				{
					// Server is down — show connection screen
					window.__RETOLD_SERVER_URL__ = '';
					_showConnectionScreen();
				});
		}
		else
		{
			// No saved server — show connection screen
			_showConnectionScreen();
		}

		// Install media interception (it waits for pict to load via setInterval)
		_installMediaInterception();
	}

	// Run DOM init when DOM is ready (or immediately if already ready)
	if (document.readyState === 'loading')
	{
		document.addEventListener('DOMContentLoaded', _initDOM);
	}
	else
	{
		_initDOM();
	}
})();
