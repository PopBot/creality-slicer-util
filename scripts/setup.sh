#!/usr/bin/env bash
# ==============================================================================
# Creality K1 Slicer Util - One-Click Environment Setup Script
# ==============================================================================
set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}======================================================${NC}"
echo -e "${BLUE}  ⚡ Creality K1 Slicer Util - Automated Setup${NC}"
echo -e "${BLUE}======================================================${NC}\n"

# 1. Detect Operating System
OS="$(uname -s)"
echo -e "🔍 Detected Operating System: ${GREEN}${OS}${NC}"

# 2. Check Node.js
if command -v node >/dev/null 2>&1; then
    NODE_VERSION=$(node -v)
    echo -e "✓ Node.js is installed: ${GREEN}${NODE_VERSION}${NC}"
else
    echo -e "${RED}❌ Error: Node.js (v18+) is required but not installed.${NC}"
    echo -e "   Please install Node.js from https://nodejs.org or via Homebrew: brew install node"
    exit 1
fi

# 3. Check / Install OrcaSlicer
ORCA_BINARY="/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer"
ORCA_PROFILES="/Applications/OrcaSlicer.app/Contents/Resources/profiles/Creality"

if [ -f "$ORCA_BINARY" ]; then
    echo -e "✓ OrcaSlicer Core engine found at: ${GREEN}${ORCA_BINARY}${NC}"
else
    echo -e "${YELLOW}⚠️ OrcaSlicer was not detected in /Applications.${NC}"
    if [ "$OS" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
        echo -e "   Homebrew detected! Would you like to install OrcaSlicer via brew? (y/n)"
        read -r install_orca || install_orca="y"
        if [ "$install_orca" = "y" ] || [ "$install_orca" = "Y" ]; then
            echo -e "   Running: ${BLUE}brew install --cask orcaslicer${NC}..."
            brew install --cask orcaslicer
        else
            echo -e "${YELLOW}   Skipping automated brew install. Please download OrcaSlicer manually from:${NC}"
            echo -e "   https://github.com/SoftFever/OrcaSlicer/releases"
        fi
    else
        echo -e "${YELLOW}   Please install OrcaSlicer for your platform from:${NC}"
        echo -e "   https://github.com/SoftFever/OrcaSlicer/releases"
    fi
fi

# 4. Check Creality K1 System Profiles
if [ -d "$ORCA_PROFILES" ]; then
    echo -e "✓ Creality K1 machine and process profiles verified: ${GREEN}${ORCA_PROFILES}${NC}"
else
    echo -e "${YELLOW}⚠️ Warning: Creality profiles directory not found at standard path.${NC}"
    echo -e "   You can point to custom profiles with: export ORCA_PROFILES_DIR=/path/to/profiles/Creality"
fi

# 5. Install Node Dependencies
echo -e "\n📦 Installing project dependencies..."
npm install

# 6. Build TypeScript
echo -e "\n🔨 Building TypeScript binaries and server..."
npm run build

# 7. Global CLI Link
echo -e "\n🔗 Linking 'k1-slice' CLI command globally..."
if npm link --force >/dev/null 2>&1; then
    echo -e "✓ Successfully linked ${GREEN}k1-slice${NC} globally! You can now run 'k1-slice' from anywhere."
else
    echo -e "${YELLOW}⚠️ npm link required elevated permissions. You can link later using: sudo npm link${NC}"
fi

# 8. Run Verification Test
echo -e "\n🧪 Running validation suite & test slice..."
npm test

echo -e "\n${GREEN}======================================================${NC}"
echo -e "${GREEN}  🎉 Setup Complete! You are ready to slice for K1.${NC}"
echo -e "${GREEN}======================================================${NC}"
echo -e "\n🚀 Quick Commands:"
echo -e "   - Open 3D Studio in browser:       ${BLUE}k1-slice${NC}"
echo -e "   - Slice a model in 0.2s:           ${BLUE}k1-slice samples/k1_calibration_cube.stl${NC}"
echo -e "   - Slice & preview in 3D:           ${BLUE}k1-slice samples/k1_calibration_cube.stl --preview${NC}"
echo -e "   - Send directly to your K1:        ${BLUE}k1-slice <model.stl> --printer-ip <IP> --print${NC}\n"
