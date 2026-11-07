const API_BASE = 'https://opentdb.com';
const QUESTION_TIME = 30;
const MAX_NAME_LENGTH = 30;
const MIN_FAMILY_PLAYERS = 2;
const MAX_PLAYERS = 6;
const HIGH_SCORES_KEY = 'triviaHighScores';
const PREFS_KEY = 'triviaPrefs';
const ANSWER_LETTERS = ['A', 'B', 'C', 'D'];
const TIMER_CIRCUMFERENCE = 2 * Math.PI * 19; // matches r="19" in the timer SVG
const REVEAL_DELAY = 1500;
const SEGMENTED_PROGRESS_LIMIT = 20;

const DIFFICULTIES = ['', 'easy', 'medium', 'hard'];
const QUESTION_TYPES = ['multiple', 'boolean', ''];
// Solo: total questions. Family: questions per player (max 6 x 8 = 48, under the API's 50 limit).
const COUNT_OPTIONS = { solo: [5, 10, 15, 20], family: [3, 5, 8] };
const DEFAULT_COUNT = { solo: 10, family: 5 };

const SCORING = {
    base: 100,          // every correct answer
    maxSpeedBonus: 50,  // scaled by how much time was left
    streakStep: 25,     // per answer in a row after the first
    maxStreakBonus: 100,
};

function calculatePoints(timeFractionLeft, streak) {
    const speed = Math.round(SCORING.maxSpeedBonus * Math.min(Math.max(timeFractionLeft, 0), 1));
    const streakBonus = Math.min(Math.max(streak - 1, 0) * SCORING.streakStep, SCORING.maxStreakBonus);
    return { base: SCORING.base, speed, streak: streakBonus, total: SCORING.base + speed + streakBonus };
}

// Fisher–Yates shuffle (unbiased, unlike sort(() => Math.random() - 0.5))
function shuffle(items) {
    const arr = [...items];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// Small helper to build DOM nodes safely. Text is always set via textContent,
// so data from the API or from players can never be interpreted as HTML.
function el(tag, { className, text } = {}, children = []) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    children.forEach(child => node.appendChild(child));
    return node;
}

function initial(name) {
    return [...name.trim()][0] || '?';
}

function formatPoints(points) {
    return points.toLocaleString();
}

function capitalize(text) {
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function readStorage(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch {
        return fallback;
    }
}

function writeStorage(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
        console.error(`Could not save ${key}:`, error);
    }
}

function playSound(audio) {
    if (!audio) return;
    audio.currentTime = 0;
    audio.play().catch(() => { /* autoplay blocked or not loaded; ignore */ });
}

function resultMessage(correct, total) {
    const ratio = total ? correct / total : 0;
    if (ratio === 1) return { emoji: '🏆', title: 'Perfect game!' };
    if (ratio >= 0.8) return { emoji: '🚀', title: 'Out of this world!' };
    if (ratio >= 0.5) return { emoji: '🎉', title: 'Nice work!' };
    if (ratio >= 0.3) return { emoji: '💪', title: 'Good effort!' };
    return { emoji: '🌱', title: 'Keep going!' };
}

class TriviaGame {
    constructor() {
        this.mode = 'solo';
        this.familyNames = ['', ''];
        this.counts = { ...DEFAULT_COUNT };
        this.preferredCategory = '';
        this.categories = [];
        this.sessionToken = null;

        this.config = null;
        this.players = [];
        this.questions = [];
        this.results = [];
        this.answerButtons = [];
        this.currentQuestion = 0;
        this.timer = null;
        this.advanceTimeout = null;
        this.timeLeft = QUESTION_TIME;
        this.questionStartedAt = 0;
        this.gameId = 0;
        this.lastEntryIds = new Set();

        this.tickSound = document.getElementById('tick-sound');
        this.correctSound = document.getElementById('correct-sound');
        this.wrongSound = document.getElementById('wrong-sound');
        this.timeoutSound = document.getElementById('timeout-sound');

        this.initializeGame();
    }

    async initializeGame() {
        this.loadPrefs();
        this.setupEventListeners();
        this.renderModeUI();
        this.showStartScreen();
        await this.loadCategories();
    }

    // ---- Preferences (remembered per browser) -------------------------------

    loadPrefs() {
        const prefs = readStorage(PREFS_KEY, {});
        if (!prefs || typeof prefs !== 'object') return;

        this.mode = prefs.mode === 'family' ? 'family' : 'solo';
        if (Array.isArray(prefs.familyNames)) {
            const names = prefs.familyNames.slice(0, MAX_PLAYERS).map(n => String(n ?? '').slice(0, MAX_NAME_LENGTH));
            while (names.length < MIN_FAMILY_PLAYERS) names.push('');
            this.familyNames = names;
        }
        ['solo', 'family'].forEach(mode => {
            const count = Number(prefs.counts?.[mode]);
            if (COUNT_OPTIONS[mode].includes(count)) this.counts[mode] = count;
        });
        document.getElementById('player-name').value = String(prefs.soloName ?? '').slice(0, MAX_NAME_LENGTH);
        if (DIFFICULTIES.includes(prefs.difficulty)) document.getElementById('difficulty').value = prefs.difficulty;
        if (QUESTION_TYPES.includes(prefs.type)) document.getElementById('question-type').value = prefs.type;
        this.preferredCategory = String(prefs.category ?? '');
    }

    savePrefs() {
        writeStorage(PREFS_KEY, {
            mode: this.mode,
            familyNames: this.familyNames,
            counts: this.counts,
            soloName: document.getElementById('player-name').value.trim(),
            difficulty: document.getElementById('difficulty').value,
            type: document.getElementById('question-type').value,
            category: document.getElementById('category').value,
        });
    }

    // ---- API -----------------------------------------------------------------

    async fetchJson(url) {
        const response = await fetch(url, { referrerPolicy: 'no-referrer' });
        if (!response.ok) {
            throw new Error(`Request failed with status ${response.status}`);
        }
        return response.json();
    }

    async loadCategories() {
        try {
            const data = await this.fetchJson(`${API_BASE}/api_category.php`);
            this.categories = Array.isArray(data.trivia_categories) ? data.trivia_categories : [];
        } catch (error) {
            console.error('Error loading categories:', error);
            this.categories = [];
        }
        this.populateCategorySelect();
    }

    populateCategorySelect() {
        const select = document.getElementById('category');
        const anyOption = el('option', { text: 'Any category' });
        anyOption.value = '';
        select.replaceChildren(anyOption);
        this.categories.forEach(category => {
            const option = el('option', { text: category.name });
            option.value = String(category.id);
            select.appendChild(option);
        });
        if (this.categories.some(c => String(c.id) === this.preferredCategory)) {
            select.value = this.preferredCategory;
        }
    }

    async getSessionToken() {
        // A session token stops OpenTDB from repeating questions across games.
        if (this.sessionToken) return this.sessionToken;
        try {
            const data = await this.fetchJson(`${API_BASE}/api_token.php?command=request`);
            if (data.response_code === 0) this.sessionToken = data.token;
        } catch {
            // Tokens are optional; continue without one.
        }
        return this.sessionToken;
    }

    async fetchQuestions(amount, retried = false) {
        const { difficulty, type, category } = this.config;
        const params = new URLSearchParams({
            amount: String(amount),
            // URL-encoded responses decode to plain text, so nothing needs to go through innerHTML.
            encode: 'url3986',
        });
        if (type) params.set('type', type);
        if (difficulty) params.set('difficulty', difficulty);
        if (category) params.set('category', category);
        const token = await this.getSessionToken();
        if (token) params.set('token', token);

        const data = await this.fetchJson(`${API_BASE}/api.php?${params}`);

        switch (data.response_code) {
            case 0:
                break;
            case 3: // token not found
            case 4: // token exhausted: every question for these settings has been seen
                this.sessionToken = null;
                if (!retried) return this.fetchQuestions(amount, true);
                break;
            case 5: // rate limited: OpenTDB allows one request every 5 seconds
                if (!retried) {
                    await new Promise(resolve => setTimeout(resolve, 5500));
                    return this.fetchQuestions(amount, true);
                }
                break;
        }

        if (data.response_code !== 0 || !Array.isArray(data.results) || data.results.length < amount) {
            const error = new Error(`Unexpected API response code ${data.response_code}`);
            error.userMessage = data.response_code === 1
                ? 'There aren’t enough questions for those settings. Try fewer questions, another difficulty, or a different category.'
                : 'Could not load questions right now. Please try again in a moment.';
            throw error;
        }

        const decode = (value) => decodeURIComponent(value ?? '');
        this.questions = data.results.map(q => {
            const correct = decode(q.correct_answer);
            const isBoolean = decode(q.type) === 'boolean';
            return {
                question: decode(q.question),
                category: decode(q.category),
                difficulty: decode(q.difficulty).toLowerCase(),
                correctAnswer: correct,
                // Keep True/False in a predictable order.
                answers: isBoolean ? ['True', 'False'] : shuffle([...q.incorrect_answers.map(decode), correct]),
            };
        });
    }

    // ---- Start screen ----------------------------------------------------------

    setupEventListeners() {
        document.getElementById('player-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleGameStart();
        });

        document.querySelectorAll('.segment').forEach(button => {
            button.addEventListener('click', () => {
                this.mode = button.dataset.mode === 'family' ? 'family' : 'solo';
                this.setFormError('');
                this.renderModeUI();
            });
        });

        document.getElementById('add-player').addEventListener('click', () => {
            if (this.familyNames.length >= MAX_PLAYERS) return;
            this.familyNames.push('');
            this.renderFamilyPlayers();
            const inputs = document.querySelectorAll('#family-players input');
            inputs[inputs.length - 1].focus();
        });

        document.getElementById('question-count').addEventListener('change', (e) => {
            const count = Number(e.target.value);
            if (COUNT_OPTIONS[this.mode].includes(count)) this.counts[this.mode] = count;
        });

        document.getElementById('play-again').addEventListener('click', () => this.showStartScreen());
        document.getElementById('rematch').addEventListener('click', () => {
            if (this.config) this.startGame(this.config);
        });
        document.getElementById('view-scores').addEventListener('click', () => this.showLeaderboardOnly());
        document.getElementById('end-game').addEventListener('click', () => {
            if (window.confirm('End this game? Scores from this game won’t be saved.')) {
                this.showStartScreen();
            }
        });
        document.getElementById('clear-scores').addEventListener('click', () => {
            if (window.confirm('Clear all high scores?')) {
                this.clearHighScores();
            }
        });

        // Keyboard shortcuts: 1-4 or A-D to pick an answer.
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            if (document.getElementById('game-screen').classList.contains('hidden')) return;
            const key = e.key.toUpperCase();
            let index = ANSWER_LETTERS.indexOf(key);
            if (index === -1 && /^[1-4]$/.test(key)) index = Number(key) - 1;
            const entry = this.answerButtons[index];
            if (entry && !entry.button.disabled) {
                e.preventDefault();
                entry.button.click();
            }
        });
    }

    renderModeUI() {
        const isFamily = this.mode === 'family';
        document.querySelectorAll('.segment').forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.mode === this.mode));
        });
        document.getElementById('solo-fields').classList.toggle('hidden', isFamily);
        document.getElementById('family-fields').classList.toggle('hidden', !isFamily);
        document.getElementById('question-count-label').textContent = isFamily ? 'Questions each' : 'Questions';

        const select = document.getElementById('question-count');
        select.replaceChildren(...COUNT_OPTIONS[this.mode].map(count => {
            const option = el('option', { text: String(count) });
            option.value = String(count);
            return option;
        }));
        select.value = String(this.counts[this.mode]);

        if (isFamily) this.renderFamilyPlayers();
    }

    renderFamilyPlayers() {
        const list = document.getElementById('family-players');
        list.replaceChildren(...this.familyNames.map((name, i) => {
            const avatar = el('span', { className: 'avatar', text: name.trim() ? initial(name) : String(i + 1) });
            avatar.setAttribute('aria-hidden', 'true');

            const input = el('input');
            input.type = 'text';
            input.maxLength = MAX_NAME_LENGTH;
            input.value = name;
            input.placeholder = `Player ${i + 1}`;
            input.setAttribute('aria-label', `Player ${i + 1} name`);
            input.autocomplete = 'off';
            input.addEventListener('input', () => {
                this.familyNames[i] = input.value;
                avatar.textContent = input.value.trim() ? initial(input.value) : String(i + 1);
            });

            const remove = el('button', { className: 'icon-btn', text: '×' });
            remove.type = 'button';
            remove.setAttribute('aria-label', `Remove player ${i + 1}`);
            remove.disabled = this.familyNames.length <= MIN_FAMILY_PLAYERS;
            remove.addEventListener('click', () => {
                this.familyNames.splice(i, 1);
                this.renderFamilyPlayers();
            });

            return el('li', { className: 'family-player' }, [avatar, input, remove]);
        }));
        document.getElementById('add-player').disabled = this.familyNames.length >= MAX_PLAYERS;
    }

    setFormError(message) {
        document.getElementById('form-error').textContent = message;
    }

    collectPlayerNames() {
        if (this.mode === 'solo') {
            const name = document.getElementById('player-name').value.trim().slice(0, MAX_NAME_LENGTH);
            return name ? { names: [name] } : { error: 'Please enter your name.', focus: document.getElementById('player-name') };
        }

        const names = this.familyNames.map(n => n.trim().slice(0, MAX_NAME_LENGTH));
        const inputs = document.querySelectorAll('#family-players input');
        const emptyIndex = names.findIndex(n => !n);
        if (emptyIndex !== -1) {
            return { error: 'Every player needs a name.', focus: inputs[emptyIndex] };
        }
        const seen = new Set();
        for (let i = 0; i < names.length; i++) {
            const key = names[i].toLowerCase();
            if (seen.has(key)) return { error: 'Each player needs a different name.', focus: inputs[i] };
            seen.add(key);
        }
        return { names };
    }

    handleGameStart() {
        const { names, error, focus } = this.collectPlayerNames();
        if (error) {
            this.setFormError(error);
            focus?.focus();
            return;
        }
        this.setFormError('');

        const difficulty = document.getElementById('difficulty').value;
        const type = document.getElementById('question-type').value;
        const categoryValue = document.getElementById('category').value;
        const count = Number(document.getElementById('question-count').value);

        this.savePrefs();
        this.startGame({
            mode: this.mode,
            names,
            difficulty: DIFFICULTIES.includes(difficulty) ? difficulty : '',
            type: QUESTION_TYPES.includes(type) ? type : 'multiple',
            // Only accept category ids that came from the API list.
            category: this.categories.some(c => String(c.id) === categoryValue) ? categoryValue : '',
            count: COUNT_OPTIONS[this.mode].includes(count) ? count : DEFAULT_COUNT[this.mode],
        });
    }

    // ---- Screens -----------------------------------------------------------------

    showScreen(screenId) {
        document.querySelectorAll('.screen').forEach(screen => {
            screen.classList.add('hidden');
        });
        document.getElementById(screenId).classList.remove('hidden');
    }

    showStartScreen() {
        this.gameId++; // cancels any game still loading
        this.stopTimers();
        this.answerButtons = [];
        this.showScreen('start-screen');
    }

    stopTimers() {
        clearInterval(this.timer);
        clearTimeout(this.advanceTimeout);
        this.timer = null;
        this.advanceTimeout = null;
    }

    showMessage(message, { spinner = false, backButton = false } = {}) {
        const children = [];
        if (spinner) children.push(el('span', { className: 'spinner' }));
        children.push(el('p', { text: message }));
        if (backButton) {
            const back = el('button', { className: 'btn btn-ghost', text: '← Back' });
            back.type = 'button';
            back.addEventListener('click', () => this.showStartScreen());
            children.push(back);
        }
        document.getElementById('game-area').replaceChildren(el('div', { className: 'loader' }, children));
    }

    // ---- Game flow -----------------------------------------------------------------

    get isFamily() {
        return this.config?.mode === 'family';
    }

    get currentPlayerIndex() {
        return this.currentQuestion % this.players.length;
    }

    get currentPlayer() {
        return this.players[this.currentPlayerIndex];
    }

    get totalQuestions() {
        return this.config.count * this.config.names.length;
    }

    async startGame(config) {
        const gameId = ++this.gameId;
        this.stopTimers();
        this.config = config;
        this.players = config.names.map(name => ({
            name, points: 0, correct: 0, answered: 0, streak: 0, bestStreak: 0,
        }));
        this.questions = [];
        this.results = [];
        this.answerButtons = [];
        this.currentQuestion = 0;
        this.lastEntryIds = new Set();

        this.updateHud(false);
        this.renderScoreboard();
        this.resetTimerDisplay();
        this.renderProgress();
        this.showScreen('game-screen');
        this.showMessage('Loading questions...', { spinner: true });

        try {
            await this.fetchQuestions(this.totalQuestions);
            if (gameId !== this.gameId) return; // player left while loading
            this.beginTurn();
        } catch (error) {
            if (gameId !== this.gameId) return;
            console.error('Error fetching questions:', error);
            this.showMessage(error.userMessage || 'Could not load questions. Please check your connection and try again.', { backButton: true });
        }
    }

    beginTurn() {
        this.updateHud(false);
        this.renderScoreboard();
        this.renderProgress();
        if (this.isFamily) {
            this.showPassScreen();
        } else {
            this.renderQuestion();
        }
    }

    showPassScreen() {
        const player = this.currentPlayer;
        const round = Math.floor(this.currentQuestion / this.players.length) + 1;
        this.answerButtons = [];
        this.resetTimerDisplay();

        const avatar = el('div', { className: 'avatar avatar-lg', text: initial(player.name) });
        avatar.setAttribute('aria-hidden', 'true');
        const ready = el('button', { className: 'btn btn-primary', text: 'I’m ready!' });
        ready.type = 'button';
        ready.addEventListener('click', () => this.renderQuestion());

        document.getElementById('game-area').replaceChildren(
            el('div', { className: 'pass-screen' }, [
                avatar,
                el('p', { className: 'eyebrow', text: `Round ${round} of ${this.config.count}` }),
                el('h2', { className: 'pass-title', text: `${player.name}’s turn` }),
                el('p', { className: 'pass-text', text: `Pass the device to ${player.name}. The timer starts when you’re ready.` }),
                ready,
            ])
        );
        ready.focus({ preventScroll: true });
    }

    renderQuestion() {
        const question = this.questions[this.currentQuestion];

        this.answerButtons = question.answers.map((answer, i) => {
            const button = el('button', { className: 'answer-btn' }, [
                el('span', { className: 'answer-letter', text: ANSWER_LETTERS[i] }),
                el('span', { className: 'answer-text', text: answer }),
            ]);
            button.type = 'button';
            button.addEventListener('click', () => this.handleAnswer(button, answer));
            return { button, answer };
        });

        const position = this.isFamily
            ? `Round ${Math.floor(this.currentQuestion / this.players.length) + 1} of ${this.config.count}`
            : `Question ${this.currentQuestion + 1} of ${this.questions.length}`;
        const meta = el('div', { className: 'question-meta' }, [el('span', { text: position })]);
        if (question.category) meta.appendChild(el('span', { className: 'pill', text: question.category }));
        if (['easy', 'medium', 'hard'].includes(question.difficulty)) {
            meta.appendChild(el('span', { className: `pill pill-${question.difficulty}`, text: question.difficulty }));
        }

        const children = [
            meta,
            el('h2', { className: 'question', text: question.question }),
            el('div', { className: 'answers' }, this.answerButtons.map(a => a.button)),
            el('div', { className: 'feedback' }),
        ];
        // Show the keyboard tip on each player's first question.
        if (this.currentQuestion < this.players.length) {
            const last = question.answers.length;
            const hint = el('p', { className: 'keyboard-hint' });
            hint.append('Tip: press ', el('kbd', { text: '1' }), '–', el('kbd', { text: String(last) }), ' or ',
                el('kbd', { text: 'A' }), '–', el('kbd', { text: ANSWER_LETTERS[last - 1] }), ' to answer');
            children.push(hint);
        }

        document.getElementById('game-area').replaceChildren(el('div', { className: 'question-card' }, children));
        this.startTimer();
    }

    handleAnswer(buttonElement, selectedAnswer) {
        clearInterval(this.timer);
        const player = this.currentPlayer;
        player.answered++;

        if (selectedAnswer === this.questions[this.currentQuestion].correctAnswer) {
            player.streak++;
            player.bestStreak = Math.max(player.bestStreak, player.streak);
            const elapsed = (performance.now() - this.questionStartedAt) / 1000;
            const points = calculatePoints(1 - elapsed / QUESTION_TIME, player.streak);
            player.points += points.total;
            player.correct++;
            playSound(this.correctSound);
            this.updateHud(true);
            this.revealAnswers(buttonElement, 'correct', points);
        } else {
            player.streak = 0;
            playSound(this.wrongSound);
            this.updateHud(false);
            this.revealAnswers(buttonElement, 'wrong');
        }
    }

    handleTimeUp() {
        const player = this.currentPlayer;
        player.answered++;
        player.streak = 0;
        this.updateHud(false);
        this.revealAnswers(null, 'timeout');
    }

    revealAnswers(selectedButton, outcome, points = null) {
        const { correctAnswer } = this.questions[this.currentQuestion];
        this.answerButtons.forEach(({ button, answer }) => {
            button.disabled = true;
            if (answer === correctAnswer) {
                button.classList.add('correct');
            } else if (button === selectedButton) {
                button.classList.add('incorrect');
            }
        });

        const feedback = document.querySelector('.feedback');
        if (outcome === 'correct') {
            feedback.classList.add('is-correct');
            feedback.append(el('p', { text: `Correct! +${points.total}` }));
            const bonuses = [];
            if (points.speed > 0) bonuses.push(el('span', { className: 'bonus', text: `⚡ +${points.speed} speed` }));
            if (points.streak > 0) bonuses.push(el('span', { className: 'bonus', text: `🔥 +${points.streak} streak` }));
            if (bonuses.length) feedback.append(el('div', { className: 'points-breakdown' }, bonuses));
        } else {
            feedback.classList.add('is-wrong');
            const lead = outcome === 'timeout' ? 'Time’s up!' : 'Not quite.';
            feedback.append(el('p', { text: `${lead} The answer was “${correctAnswer}”.` }));
        }

        this.results[this.currentQuestion] = outcome === 'correct';
        this.renderProgress();
        this.renderScoreboard();
        this.advanceTimeout = setTimeout(() => this.proceedToNext(), outcome === 'correct' ? REVEAL_DELAY : REVEAL_DELAY + 700);
    }

    proceedToNext() {
        if (this.currentQuestion < this.questions.length - 1) {
            this.currentQuestion++;
            this.beginTurn();
        } else {
            this.endGame();
        }
    }

    endGame() {
        this.stopTimers();
        this.answerButtons = [];
        this.saveResults();
        this.showResults();
    }

    // ---- HUD, timer, progress -----------------------------------------------------

    updateHud(animate) {
        const player = this.currentPlayer;
        if (!player) return;
        document.getElementById('player-display').textContent = player.name;
        document.getElementById('player-avatar').textContent = initial(player.name);
        document.getElementById('score-display').textContent = formatPoints(player.points);

        const streakChip = document.getElementById('streak-chip');
        streakChip.classList.toggle('hidden', player.streak < 2);
        streakChip.textContent = `🔥 ${player.streak}`;
        streakChip.setAttribute('aria-label', `${player.streak} in a row`);

        const scoreChip = document.querySelector('.score-chip');
        [scoreChip, streakChip].forEach(chip => chip.classList.remove('bump'));
        if (animate) {
            void scoreChip.offsetWidth; // restart the animation
            scoreChip.classList.add('bump');
            if (player.streak >= 2) streakChip.classList.add('bump');
        }
    }

    renderScoreboard() {
        const board = document.getElementById('scoreboard');
        board.classList.toggle('hidden', !this.isFamily);
        document.getElementById('game-screen').classList.toggle('is-family', this.isFamily);
        if (!this.isFamily) return;
        board.replaceChildren(...this.players.map((player, i) => {
            const avatar = el('span', { className: 'avatar', text: initial(player.name) });
            avatar.setAttribute('aria-hidden', 'true');
            const item = el('li', { className: 'scoreboard-item' }, [
                avatar,
                el('span', { text: player.name }),
                el('span', { className: 'scoreboard-points', text: formatPoints(player.points) }),
            ]);
            if (i === this.currentPlayerIndex) {
                item.classList.add('is-current');
                item.setAttribute('aria-current', 'true');
            }
            return item;
        }));
        board.querySelector('.is-current')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    renderProgress() {
        const progress = document.getElementById('progress');
        const total = this.config ? this.totalQuestions : 0;

        if (total > SEGMENTED_PROGRESS_LIMIT) {
            const done = this.results.filter(r => r !== undefined).length;
            const fill = el('span');
            fill.style.width = `${(done / total) * 100}%`;
            const track = el('li', { className: 'progress-continuous' }, [fill]);
            track.setAttribute('aria-label', `${done} of ${total} questions answered`);
            progress.replaceChildren(track);
            return;
        }

        progress.replaceChildren(...Array.from({ length: total }, (_, i) => {
            const item = el('li');
            const result = this.results[i];
            let state = 'upcoming';
            if (result === true) state = 'correct';
            else if (result === false) state = 'wrong';
            else if (i === this.currentQuestion) state = 'current';
            if (state !== 'upcoming') item.className = `is-${state}`;
            item.setAttribute('aria-label', `Question ${i + 1}: ${state}`);
            return item;
        }));
    }

    resetTimerDisplay() {
        this.timeLeft = QUESTION_TIME;
        const ring = document.getElementById('timer-ring');
        // Jump back to full without animating the ring backwards.
        ring.style.transition = 'none';
        this.updateTimerDisplay();
        void ring.getBoundingClientRect();
        ring.style.transition = '';
    }

    startTimer() {
        this.resetTimerDisplay();
        clearInterval(this.timer);
        this.questionStartedAt = performance.now();

        this.timer = setInterval(() => {
            this.timeLeft--;
            this.updateTimerDisplay();

            if (this.timeLeft <= 5 && this.timeLeft > 0) {
                playSound(this.tickSound);
            }

            if (this.timeLeft <= 0) {
                clearInterval(this.timer);
                playSound(this.timeoutSound);
                this.handleTimeUp();
            }
        }, 1000);
    }

    updateTimerDisplay() {
        document.getElementById('timer-text').textContent = this.timeLeft;
        const timer = document.getElementById('timer');
        timer.setAttribute('aria-label', `${this.timeLeft} seconds remaining`);
        timer.classList.toggle('is-low', this.timeLeft <= 10 && this.timeLeft > 5);
        timer.classList.toggle('is-critical', this.timeLeft <= 5);
        const elapsed = 1 - this.timeLeft / QUESTION_TIME;
        document.getElementById('timer-ring').style.strokeDashoffset = String(TIMER_CIRCUMFERENCE * elapsed);
    }

    // ---- Results & high scores -------------------------------------------------------

    rankedPlayers() {
        return [...this.players].sort((a, b) => b.points - a.points || b.correct - a.correct);
    }

    saveResults() {
        const category = this.categories.find(c => String(c.id) === this.config.category);
        const highScores = this.getHighScores();
        const now = Date.now();
        this.lastEntryIds = new Set();

        this.players.forEach((player, i) => {
            const id = now + i;
            this.lastEntryIds.add(id);
            highScores.push({
                id,
                name: player.name,
                points: player.points,
                score: player.correct,
                total: this.config.count,
                category: category ? category.name : 'Any category',
                difficulty: this.config.difficulty,
                mode: this.config.mode,
                date: new Date().toLocaleDateString(),
            });
        });

        highScores.sort((a, b) => b.points - a.points);
        writeStorage(HIGH_SCORES_KEY, highScores.slice(0, 10));
    }

    getHighScores() {
        const parsed = readStorage(HIGH_SCORES_KEY, []);
        if (!Array.isArray(parsed)) return [];
        // Treat stored data as untrusted: keep only well-formed entries.
        return parsed
            .filter(s => s && typeof s === 'object' && Number.isFinite(s.score))
            .map(s => ({
                id: Number.isFinite(s.id) ? s.id : null,
                name: String(s.name ?? '').slice(0, MAX_NAME_LENGTH),
                // Scores saved before points existed count 100 per correct answer.
                points: Number.isFinite(s.points) ? s.points : s.score * SCORING.base,
                score: s.score,
                total: Number.isFinite(s.total) ? s.total : 10,
                category: String(s.category ?? ''),
                difficulty: DIFFICULTIES.includes(s.difficulty) ? s.difficulty : '',
                mode: s.mode === 'family' ? 'family' : 'solo',
                date: String(s.date ?? ''),
            }))
            .sort((a, b) => b.points - a.points);
    }

    clearHighScores() {
        try {
            localStorage.removeItem(HIGH_SCORES_KEY);
        } catch {
            // Storage unavailable; nothing to clear.
        }
        this.renderLeaderboard();
    }

    scoreRow({ rank, name, meta, points, isNew }) {
        const medals = ['🥇', '🥈', '🥉'];
        const item = el('li', { className: 'score-item' }, [
            el('span', { className: 'score-rank', text: medals[rank - 1] || String(rank) }),
            el('span', { className: 'score-player' }, [
                el('span', { className: 'score-name', text: name }),
                el('span', { className: 'score-meta', text: meta }),
            ]),
            el('span', { className: 'score-value', text: `${formatPoints(points)} pts` }),
        ]);
        if (isNew) item.classList.add('is-new');
        return item;
    }

    renderLeaderboard() {
        const highScores = this.getHighScores();
        const list = document.getElementById('high-scores-list');

        if (highScores.length === 0) {
            list.replaceChildren(el('li', { className: 'empty-state', text: 'No high scores yet. Be the first!' }));
            return;
        }

        list.replaceChildren(...highScores.map((s, index) => this.scoreRow({
            rank: index + 1,
            name: s.name,
            meta: [
                `${s.score}/${s.total} correct`,
                s.mode === 'family' ? 'Family night' : null,
                s.category,
                capitalize(s.difficulty),
                s.date,
            ].filter(Boolean).join(' · '),
            points: s.points,
            isNew: s.id !== null && this.lastEntryIds.has(s.id),
        })));
    }

    renderStandings() {
        const ranked = this.rankedPlayers();
        document.getElementById('standings').replaceChildren(...ranked.map(player => this.scoreRow({
            // Players with the same points share a rank.
            rank: 1 + ranked.filter(p => p.points > player.points).length,
            name: player.name,
            meta: [
                `${player.correct}/${player.answered} correct`,
                player.bestStreak >= 2 ? `best streak 🔥 ${player.bestStreak}` : null,
            ].filter(Boolean).join(' · '),
            points: player.points,
            isNew: false,
        })));
    }

    showResults() {
        const emojiEl = document.getElementById('result-emoji');
        const titleEl = document.getElementById('result-title');
        const subtitleEl = document.getElementById('result-subtitle');
        const streakText = (p) => (p.bestStreak >= 2 ? ` · Best streak 🔥 ${p.bestStreak}` : '');

        if (this.isFamily) {
            const ranked = this.rankedPlayers();
            const top = ranked[0];
            const winners = ranked.filter(p => p.points === top.points);
            emojiEl.textContent = winners.length > 1 ? '🤝' : '🏆';
            titleEl.textContent = winners.length > 1
                ? `It’s a tie: ${winners.map(p => p.name).join(' & ')}!`
                : `${top.name} wins!`;
            subtitleEl.textContent = `${top.correct}/${top.answered} correct${streakText(top)}`;
            document.getElementById('result-score').textContent = formatPoints(top.points);
            this.renderStandings();
        } else {
            const player = this.players[0];
            const { emoji, title } = resultMessage(player.correct, player.answered);
            emojiEl.textContent = emoji;
            titleEl.textContent = title;
            subtitleEl.textContent = `${player.name} · ${player.correct}/${player.answered} correct${streakText(player)}`;
            document.getElementById('result-score').textContent = formatPoints(player.points);
        }

        document.getElementById('result-summary').classList.remove('hidden');
        document.getElementById('standings-wrap').classList.toggle('hidden', !this.isFamily);
        document.getElementById('rematch').classList.remove('hidden');
        document.getElementById('play-again').textContent = 'New game';
        this.renderLeaderboard();
        this.showScreen('high-scores-screen');
    }

    showLeaderboardOnly() {
        this.lastEntryIds = new Set();
        document.getElementById('result-summary').classList.add('hidden');
        document.getElementById('standings-wrap').classList.add('hidden');
        document.getElementById('rematch').classList.add('hidden');
        document.getElementById('play-again').textContent = '← Back';
        this.renderLeaderboard();
        this.showScreen('high-scores-screen');
    }
}

window.addEventListener('DOMContentLoaded', () => {
    new TriviaGame();
});
