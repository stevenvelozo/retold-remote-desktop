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
	function _shouldRewriteURL(pURL)
	{
		if (typeof pURL !== 'string') return false;
		if (!window.__RETOLD_SERVER_URL__) return false;
		return (pURL.startsWith('/api/') ||
				pURL.startsWith('/content/') ||
				pURL.startsWith('/content-hashed/'));
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
		// Patch fetch()
		var tmpOriginalFetch = window.fetch;
		window.fetch = function (pURL, pOptions)
		{
			if (typeof pURL === 'string')
			{
				pURL = _rewriteURL(pURL);
			}
			else if (pURL instanceof Request && _shouldRewriteURL(pURL.url))
			{
				pURL = new Request(_rewriteURL(pURL.url), pURL);
			}
			return tmpOriginalFetch.call(this, pURL, pOptions);
		};

		// Patch XMLHttpRequest.open()
		var tmpOriginalXHROpen = XMLHttpRequest.prototype.open;
		XMLHttpRequest.prototype.open = function (pMethod, pURL)
		{
			if (typeof pURL === 'string')
			{
				pURL = _rewriteURL(pURL);
			}
			var tmpArgs = Array.prototype.slice.call(arguments);
			tmpArgs[1] = pURL;
			return tmpOriginalXHROpen.apply(this, tmpArgs);
		};

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

		// Test the connection by fetching capabilities
		fetch(tmpURL + '/api/media/capabilities')
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

		fetch(pURL + '/api/media/capabilities')
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

	window.__retoldBridge_openLocalFolder = async function ()
	{
		if (!window.__RETOLD_NATIVE__.isTauri) return;

		try
		{
			// Import Tauri APIs
			var tmpDialog = await import('@tauri-apps/plugin-dialog');
			var tmpCore = await import('@tauri-apps/api/core');

			var tmpFolder = await tmpDialog.open({ directory: true, title: 'Select media folder' });
			if (!tmpFolder) return;

			_setStatus('Starting server...');

			var tmpResult = await tmpCore.invoke('start_server', { contentPath: tmpFolder });
			var tmpURL = 'http://localhost:' + tmpResult.port;

			_activateServer(tmpURL);
		}
		catch (pError)
		{
			_setStatus('Failed to start server: ' + pError, true);
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
		// If the app was already loaded (reconnecting), just reinitialize
		if (typeof window.RetoldRemoteApplication !== 'undefined' && typeof Pict !== 'undefined')
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
	function _installMediaInterception()
	{
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
					+ '<span class="retold-remote-video-action-key">m</span>'
					+ 'Play with Native Player'
					+ '</button>';

				// Insert before the last </div>
				tmpHTML = tmpHTML.replace(/<\/div>\s*$/, tmpNativeBtn + '</div>');

				return tmpHTML;
			};

			// Listen for 'm' key in viewer mode to trigger native playback
			var tmpOriginalHandleKey = null;
			if (pict.providers['RetoldRemote-GalleryNavigation'] &&
				pict.providers['RetoldRemote-GalleryNavigation']._keyHandlers &&
				pict.providers['RetoldRemote-GalleryNavigation']._keyHandlers.viewer)
			{
				var tmpViewerHandler = pict.providers['RetoldRemote-GalleryNavigation']._keyHandlers.viewer;
				tmpOriginalHandleKey = tmpViewerHandler.handleKey;
				tmpViewerHandler.handleKey = function (pEvent)
				{
					if (pEvent.key === 'm' && pict.AppData.RetoldRemote.CurrentViewerMediaType === 'video')
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

	window.__retoldBridge_playNativeVideo = async function ()
	{
		if (typeof pict === 'undefined') return;

		var tmpRemote = pict.AppData.RetoldRemote;
		var tmpFilePath = tmpRemote.CurrentViewerFile;
		if (!tmpFilePath) return;

		var tmpProvider = pict.providers['RetoldRemote-Provider'];
		var tmpContentURL = tmpProvider ? tmpProvider.getContentURL(tmpFilePath) : ('/content/' + encodeURIComponent(tmpFilePath));
		var tmpFullURL = _rewriteURL(tmpContentURL);
		var tmpFileName = tmpFilePath.replace(/^.*\//, '');

		if (window.__RETOLD_NATIVE__.isTauri)
		{
			try
			{
				var tmpCore = await import('@tauri-apps/api/core');
				await tmpCore.invoke('mpv_play', { url: tmpFullURL, title: tmpFileName });
			}
			catch (pError)
			{
				console.error('Native video playback failed:', pError);
				// Fall back to browser playback
				pict.views['RetoldRemote-MediaViewer'].playVideo();
			}
		}
		else if (window.__RETOLD_NATIVE__.isCapacitor)
		{
			try
			{
				var tmpNativePlayer = window.RetoldNativePlayer;
				if (tmpNativePlayer)
				{
					await tmpNativePlayer.playVideo({ url: tmpFullURL, title: tmpFileName });
				}
			}
			catch (pError)
			{
				console.error('Native video playback failed:', pError);
				pict.views['RetoldRemote-MediaViewer'].playVideo();
			}
		}
	};

	window.__retoldBridge_playNativeAudio = async function ()
	{
		if (typeof pict === 'undefined') return;

		var tmpRemote = pict.AppData.RetoldRemote;
		var tmpFilePath = tmpRemote.CurrentViewerFile;
		if (!tmpFilePath) return;

		var tmpProvider = pict.providers['RetoldRemote-Provider'];
		var tmpContentURL = tmpProvider ? tmpProvider.getContentURL(tmpFilePath) : ('/content/' + encodeURIComponent(tmpFilePath));
		var tmpFullURL = _rewriteURL(tmpContentURL);
		var tmpFileName = tmpFilePath.replace(/^.*\//, '');

		if (window.__RETOLD_NATIVE__.isTauri)
		{
			try
			{
				var tmpCore = await import('@tauri-apps/api/core');
				await tmpCore.invoke('mpv_play', { url: tmpFullURL, title: tmpFileName });
			}
			catch (pError)
			{
				console.error('Native audio playback failed:', pError);
			}
		}
		else if (window.__RETOLD_NATIVE__.isCapacitor)
		{
			try
			{
				var tmpNativePlayer = window.RetoldNativePlayer;
				if (tmpNativePlayer)
				{
					await tmpNativePlayer.playAudio({ url: tmpFullURL, title: tmpFileName });
				}
			}
			catch (pError)
			{
				console.error('Native audio playback failed:', pError);
			}
		}
	};

	// ---- Initialization ----
	function _init()
	{
		// Install URL rewriting immediately (before any API calls happen)
		_installURLRewriting();

		// Check if we have a saved server URL
		var tmpSavedURL = _getSavedServerURL();

		if (tmpSavedURL)
		{
			// Try to connect to saved server silently
			window.__RETOLD_SERVER_URL__ = tmpSavedURL;

			// Verify it's still reachable (non-blocking)
			fetch(tmpSavedURL + '/api/media/capabilities')
				.then(function (pResponse)
				{
					if (!pResponse.ok) throw new Error('unreachable');
					return pResponse.json();
				})
				.then(function ()
				{
					// Server is up — install media interception
					_installMediaInterception();
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
			// Wait for body to exist
			function _waitForBody()
			{
				if (document.body)
				{
					_showConnectionScreen();
				}
				else
				{
					setTimeout(_waitForBody, 50);
				}
			}
			_waitForBody();
		}

		// Always install media interception (it waits for pict to load)
		_installMediaInterception();
	}

	// Run init when DOM is ready (or immediately if already ready)
	if (document.readyState === 'loading')
	{
		document.addEventListener('DOMContentLoaded', _init);
	}
	else
	{
		_init();
	}
})();
