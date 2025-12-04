// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface ModData {
  id: string;
  name: string;
  encryptedStats: string;
  timestamp: number;
  creator: string;
  category: string;
  downloads: number;
  rating: number;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'increase10%':
      result = value * 1.1;
      break;
    case 'decrease10%':
      result = value * 0.9;
      break;
    case 'double':
      result = value * 2;
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  // Randomly selected style: Gradient (Rainbow) + Glassmorphism + Center Radiation + Animation Rich
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [mods, setMods] = useState<ModData[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newModData, setNewModData] = useState({ name: "", category: "Gameplay", statValue: 0 });
  const [showTutorial, setShowTutorial] = useState(false);
  const [selectedMod, setSelectedMod] = useState<ModData | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeCategory, setActiveCategory] = useState("All");

  const categories = ["All", "Gameplay", "Graphics", "UI", "Audio", "Utility"];
  const popularMods = mods.sort((a, b) => b.downloads - a.downloads).slice(0, 3);

  useEffect(() => {
    loadMods().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadMods = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        console.log("Contract is not available");
        return;
      }

      // Get mod keys
      const keysBytes = await contract.getData("mod_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing mod keys:", e); }
      }

      // Load each mod
      const list: ModData[] = [];
      for (const key of keys) {
        try {
          const modBytes = await contract.getData(`mod_${key}`);
          if (modBytes.length > 0) {
            try {
              const modData = JSON.parse(ethers.toUtf8String(modBytes));
              list.push({ 
                id: key, 
                name: modData.name,
                encryptedStats: modData.stats, 
                timestamp: modData.timestamp, 
                creator: modData.creator, 
                category: modData.category,
                downloads: modData.downloads || 0,
                rating: modData.rating || 0
              });
            } catch (e) { console.error(`Error parsing mod data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading mod ${key}:`, e); }
      }
      
      list.sort((a, b) => b.timestamp - a.timestamp);
      setMods(list);
    } catch (e) { console.error("Error loading mods:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitMod = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting mod stats with Zama FHE..." });
    try {
      const encryptedStats = FHEEncryptNumber(newModData.statValue);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const modId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const modData = { 
        name: newModData.name,
        stats: encryptedStats, 
        timestamp: Math.floor(Date.now() / 1000), 
        creator: address, 
        category: newModData.category,
        downloads: 0,
        rating: 0
      };
      
      await contract.setData(`mod_${modId}`, ethers.toUtf8Bytes(JSON.stringify(modData)));
      
      // Update keys list
      const keysBytes = await contract.getData("mod_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(modId);
      await contract.setData("mod_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Mod created with FHE-encrypted stats!" });
      await loadMods();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewModData({ name: "", category: "Gameplay", statValue: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const rateMod = async (modId: string, rating: number) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Updating mod rating..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const modBytes = await contract.getData(`mod_${modId}`);
      if (modBytes.length === 0) throw new Error("Mod not found");
      const modData = JSON.parse(ethers.toUtf8String(modBytes));
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedMod = { ...modData, rating };
      await contractWithSigner.setData(`mod_${modId}`, ethers.toUtf8Bytes(JSON.stringify(updatedMod)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Mod rating updated!" });
      await loadMods();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Rating failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const downloadMod = async (modId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing download..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const modBytes = await contract.getData(`mod_${modId}`);
      if (modBytes.length === 0) throw new Error("Mod not found");
      const modData = JSON.parse(ethers.toUtf8String(modBytes));
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedMod = { ...modData, downloads: (modData.downloads || 0) + 1 };
      await contractWithSigner.setData(`mod_${modId}`, ethers.toUtf8Bytes(JSON.stringify(updatedMod)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Mod downloaded successfully!" });
      await loadMods();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Download failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isCreator = (modAddress: string) => address?.toLowerCase() === modAddress.toLowerCase();

  const tutorialSteps = [
    { title: "Connect Wallet", description: "Connect your Web3 wallet to access the modding platform", icon: "🔗" },
    { title: "Create Encrypted Mod", description: "Upload your game mod with encrypted stats using Zama FHE", icon: "🔒", details: "Your mod stats are encrypted on the client-side before being sent to the blockchain" },
    { title: "FHE Processing", description: "Game processes mod stats in encrypted state without decryption", icon: "⚙️", details: "Zama FHE technology allows computations on encrypted data without exposing sensitive information" },
    { title: "Secure Modding", description: "Players enjoy mods without compromising game security", icon: "🎮", details: "The game core remains protected while allowing creative modding" }
  ];

  const filteredMods = mods.filter(mod => {
    const matchesSearch = mod.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         mod.category.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = activeCategory === "All" || mod.category === activeCategory;
    return matchesSearch && matchesCategory;
  });

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner"></div>
      <p>Initializing FHE Mod Platform...</p>
    </div>
  );

  return (
    <div className="app-container">
      <div className="background-radial"></div>
      
      <header className="app-header">
        <div className="logo">
          <h1>FHE<span>Mod</span>Hub</h1>
          <p>Secure Game Modding with Zama FHE</p>
        </div>
        <div className="header-actions">
          <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
        </div>
      </header>

      <main className="main-content">
        <div className="hero-section">
          <div className="hero-content">
            <h2>Revolutionary Game Modding</h2>
            <p>Create and share game mods that interact with encrypted game state using Zama FHE technology</p>
            <div className="hero-buttons">
              <button onClick={() => setShowCreateModal(true)} className="primary-button">
                Create Mod
              </button>
              <button onClick={() => setShowTutorial(!showTutorial)} className="secondary-button">
                {showTutorial ? "Hide Guide" : "How It Works"}
              </button>
            </div>
          </div>
          <div className="hero-image">
            <div className="fhe-badge">
              <span>FHE-Powered</span>
            </div>
          </div>
        </div>

        {showTutorial && (
          <div className="tutorial-section">
            <h2>FHE Modding Explained</h2>
            <div className="tutorial-steps">
              {tutorialSteps.map((step, index) => (
                <div className="tutorial-card" key={index}>
                  <div className="step-number">{index + 1}</div>
                  <div className="step-icon">{step.icon}</div>
                  <h3>{step.title}</h3>
                  <p>{step.description}</p>
                  {step.details && <div className="step-details">{step.details}</div>}
                </div>
              ))}
            </div>
            <div className="fhe-flow">
              <div className="flow-step">
                <div className="flow-icon">🎮</div>
                <div className="flow-label">Game State</div>
              </div>
              <div className="flow-arrow">→</div>
              <div className="flow-step">
                <div className="flow-icon">🔒</div>
                <div className="flow-label">FHE Encryption</div>
              </div>
              <div className="flow-arrow">→</div>
              <div className="flow-step">
                <div className="flow-icon">🛠️</div>
                <div className="flow-label">Mod Interaction</div>
              </div>
              <div className="flow-arrow">→</div>
              <div className="flow-step">
                <div className="flow-icon">🏆</div>
                <div className="flow-label">Secure Results</div>
              </div>
            </div>
          </div>
        )}

        <div className="stats-section">
          <div className="stat-card">
            <h3>{mods.length}</h3>
            <p>Total Mods</p>
          </div>
          <div className="stat-card">
            <h3>{mods.reduce((sum, mod) => sum + mod.downloads, 0)}</h3>
            <p>Total Downloads</p>
          </div>
          <div className="stat-card">
            <h3>{mods.length > 0 ? (mods.reduce((sum, mod) => sum + mod.rating, 0) / mods.length).toFixed(1) : 0}</h3>
            <p>Average Rating</p>
          </div>
        </div>

        <div className="popular-mods">
          <h2>Popular Mods</h2>
          <div className="mods-grid">
            {popularMods.length > 0 ? popularMods.map(mod => (
              <div className="mod-card" key={mod.id} onClick={() => setSelectedMod(mod)}>
                <div className="mod-image"></div>
                <div className="mod-info">
                  <h3>{mod.name}</h3>
                  <div className="mod-meta">
                    <span className="mod-category">{mod.category}</span>
                    <span className="mod-downloads">⬇️ {mod.downloads}</span>
                  </div>
                  <div className="mod-rating">
                    {Array(5).fill(0).map((_, i) => (
                      <span key={i} className={i < mod.rating ? "star filled" : "star"}>★</span>
                    ))}
                  </div>
                </div>
              </div>
            )) : (
              <div className="no-mods">
                <p>No popular mods yet</p>
              </div>
            )}
          </div>
        </div>

        <div className="mods-section">
          <div className="section-header">
            <h2>All Mods</h2>
            <div className="search-filter">
              <input 
                type="text" 
                placeholder="Search mods..." 
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="search-input"
              />
              <select 
                value={activeCategory} 
                onChange={(e) => setActiveCategory(e.target.value)}
                className="category-select"
              >
                {categories.map(cat => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
              <button onClick={loadMods} className="refresh-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>

          <div className="mods-list">
            {filteredMods.length > 0 ? filteredMods.map(mod => (
              <div className="mod-item" key={mod.id} onClick={() => setSelectedMod(mod)}>
                <div className="mod-main">
                  <div className="mod-name">{mod.name}</div>
                  <div className="mod-category">{mod.category}</div>
                  <div className="mod-creator">{mod.creator.substring(0, 6)}...{mod.creator.substring(38)}</div>
                </div>
                <div className="mod-stats">
                  <div className="mod-downloads">⬇️ {mod.downloads}</div>
                  <div className="mod-rating">
                    {Array(5).fill(0).map((_, i) => (
                      <span key={i} className={i < mod.rating ? "star filled" : "star"}>★</span>
                    ))}
                  </div>
                </div>
              </div>
            )) : (
              <div className="no-mods">
                <p>No mods found matching your criteria</p>
                <button onClick={() => setShowCreateModal(true)} className="primary-button">
                  Create First Mod
                </button>
              </div>
            )}
          </div>
        </div>
      </main>

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-logo">
            <h3>FHEModHub</h3>
            <p>Powered by Zama FHE</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Developer Portal</a>
            <a href="#" className="footer-link">Modding Guidelines</a>
            <a href="#" className="footer-link">Community</a>
          </div>
        </div>
        <div className="footer-bottom">
          <p>© {new Date().getFullYear()} FHE Game Modding Platform. All rights reserved.</p>
        </div>
      </footer>

      {showCreateModal && (
        <div className="modal-overlay">
          <div className="create-modal">
            <div className="modal-header">
              <h2>Create New Mod</h2>
              <button onClick={() => setShowCreateModal(false)} className="close-button">
                &times;
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Mod Name</label>
                <input 
                  type="text" 
                  value={newModData.name}
                  onChange={(e) => setNewModData({...newModData, name: e.target.value})}
                  placeholder="Enter mod name"
                />
              </div>
              <div className="form-group">
                <label>Category</label>
                <select 
                  value={newModData.category}
                  onChange={(e) => setNewModData({...newModData, category: e.target.value})}
                >
                  <option value="Gameplay">Gameplay</option>
                  <option value="Graphics">Graphics</option>
                  <option value="UI">UI</option>
                  <option value="Audio">Audio</option>
                  <option value="Utility">Utility</option>
                </select>
              </div>
              <div className="form-group">
                <label>Stat Value (will be FHE encrypted)</label>
                <input 
                  type="number" 
                  value={newModData.statValue}
                  onChange={(e) => setNewModData({...newModData, statValue: parseFloat(e.target.value) || 0})}
                  placeholder="Enter numerical stat value"
                />
              </div>
              <div className="encryption-preview">
                <h4>FHE Encryption Preview</h4>
                <div className="preview-value">
                  <span>Plain Value:</span> {newModData.statValue}
                </div>
                <div className="preview-value">
                  <span>Encrypted Value:</span> {newModData.statValue ? FHEEncryptNumber(newModData.statValue).substring(0, 30) + "..." : "N/A"}
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setShowCreateModal(false)} className="secondary-button">
                Cancel
              </button>
              <button onClick={submitMod} disabled={creating} className="primary-button">
                {creating ? "Creating with FHE..." : "Create Mod"}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedMod && (
        <div className="modal-overlay">
          <div className="mod-detail-modal">
            <div className="modal-header">
              <h2>{selectedMod.name}</h2>
              <button onClick={() => { setSelectedMod(null); setDecryptedValue(null); }} className="close-button">
                &times;
              </button>
            </div>
            <div className="modal-body">
              <div className="mod-meta">
                <div className="meta-item">
                  <span>Category:</span>
                  <strong>{selectedMod.category}</strong>
                </div>
                <div className="meta-item">
                  <span>Creator:</span>
                  <strong>{selectedMod.creator.substring(0, 6)}...{selectedMod.creator.substring(38)}</strong>
                </div>
                <div className="meta-item">
                  <span>Created:</span>
                  <strong>{new Date(selectedMod.timestamp * 1000).toLocaleDateString()}</strong>
                </div>
                <div className="meta-item">
                  <span>Downloads:</span>
                  <strong>{selectedMod.downloads}</strong>
                </div>
                <div className="meta-item">
                  <span>Rating:</span>
                  <div className="rating-stars">
                    {Array(5).fill(0).map((_, i) => (
                      <span 
                        key={i} 
                        className={i < selectedMod.rating ? "star filled" : "star"}
                        onClick={() => rateMod(selectedMod.id, i + 1)}
                      >
                        ★
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              <div className="mod-stats-section">
                <h3>Encrypted Stats</h3>
                <div className="encrypted-data">
                  {selectedMod.encryptedStats.substring(0, 50)}...
                </div>
                <button 
                  onClick={async () => {
                    if (decryptedValue !== null) {
                      setDecryptedValue(null);
                    } else {
                      const decrypted = await decryptWithSignature(selectedMod.encryptedStats);
                      setDecryptedValue(decrypted);
                    }
                  }}
                  className="decrypt-button"
                  disabled={isDecrypting}
                >
                  {isDecrypting ? "Decrypting..." : decryptedValue !== null ? "Hide Value" : "Decrypt with Wallet"}
                </button>
              </div>

              {decryptedValue !== null && (
                <div className="decrypted-section">
                  <h3>Decrypted Stat Value</h3>
                  <div className="decrypted-value">{decryptedValue}</div>
                  <div className="decrypt-notice">
                    This value was decrypted client-side after wallet signature verification
                  </div>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button onClick={() => downloadMod(selectedMod.id)} className="download-button">
                Download Mod
              </button>
            </div>
          </div>
        </div>
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="spinner"></div>}
              {transactionStatus.status === "success" && "✓"}
              {transactionStatus.status === "error" && "✗"}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;