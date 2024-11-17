class TriviaGame {
    constructor() {
        this.questions = [];
        this.currentQuestion = 0;
        this.score = 0;
        this.timer = null;
        this.timeLeft = 30;
        this.playerName = '';
        this.categories = [];
        this.selectedCategory = '';
        
        // start elements
        this.tickSound = document.getElementById('tick-sound');
        this.correctSound = document.getElementById('correct-sound');
        this.wrongSound = document.getElementById('wrong-sound');
        this.timeoutSound = document.getElementById('timeout-sound');
        
        // initialize the game
        this.initializeGame();
    }

    async initializeGame() {
        await this.loadCategories();
        this.setupEventListeners();
        this.showStartScreen();
    }

    async loadCategories() {
        try {
            const response = await fetch('https://opentdb.com/api_category.php');
            const data = await response.json();
            this.categories = data.trivia_categories;
            this.populateCategorySelect();
        } catch (error) {
            console.error('Error loading categories:', error);
        }
    }

    populateCategorySelect() {
        const select = document.getElementById('category');
        select.innerHTML = '<option value="">Any Category</option>';
        this.categories.forEach(category => {
            const option = document.createElement('option');
            option.value = category.id;
            option.textContent = category.name;
            select.appendChild(option);
        });
    }

    setupEventListeners() {
        // start game form submission
        document.getElementById('player-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleGameStart();
        });

        // play again button
        document.getElementById('play-again').addEventListener('click', () => {
            this.showStartScreen();
        });

        // clear high scores button
        document.getElementById('clear-scores').addEventListener('click', () => {
            this.clearHighScores();
        });
    }

    showScreen(screenId) {
        // hide all screens
        document.querySelectorAll('.screen').forEach(screen => {
            screen.classList.add('hidden');
        });
        // show the requested screen
        document.getElementById(screenId).classList.remove('hidden');
    }

    showStartScreen() {
        this.showScreen('start-screen');
    }

    async handleGameStart() {
        this.playerName = document.getElementById('player-name').value;
        this.selectedCategory = document.getElementById('category').value;
        document.getElementById('player-display').textContent = `Player: ${this.playerName}`;
        this.showScreen('game-screen');
        this.currentQuestion = 0;
        this.score = 0;
        await this.fetchQuestions();
        this.renderQuestion();
    }

    async fetchQuestions() {
        try {
            const categoryParam = this.selectedCategory ? `&category=${this.selectedCategory}` : '';
            const url = `https://opentdb.com/api.php?amount=10&type=multiple${categoryParam}`;
            const response = await fetch(url);
            const data = await response.json();
            this.questions = data.results.map(q => ({
                ...q,
                answers: [...q.incorrect_answers, q.correct_answer].sort(() => Math.random() - 0.5)
            }));
        } catch (error) {
            console.error('Error fetching questions:', error);
        }
    }

    startTimer() {
        this.timeLeft = 30;
        this.updateTimerDisplay();

        if (this.timer) {
            clearInterval(this.timer);
        }

        this.timer = setInterval(() => {
            this.timeLeft--;
            this.updateTimerDisplay();

            // play tick sound for last 5 seconds
            if (this.timeLeft <= 5 && this.timeLeft > 0) {
                this.tickSound.play().catch(e => console.log('Audio play error:', e));
                document.getElementById('timer-fill').classList.add('time-warning');
            }

            if (this.timeLeft <= 0) {
                clearInterval(this.timer);
                this.timeoutSound.play().catch(e => console.log('Audio play error:', e));
                this.handleTimeUp();
            }
        }, 1000);
    }

    updateTimerDisplay() {
        const timerText = document.getElementById('timer-text');
        const timerFill = document.getElementById('timer-fill');
        
        timerText.textContent = this.timeLeft;
        timerFill.style.width = `${(this.timeLeft / 30) * 100}%`;
    }

    handleTimeUp() {
        const buttons = document.querySelectorAll('.answer-btn');
        buttons.forEach(btn => {
            btn.disabled = true;
            if (btn.dataset.answer === this.questions[this.currentQuestion].correct_answer) {
                btn.classList.add('correct');
            }
        });

        setTimeout(() => this.proceedToNext(), 1500);
    }

    renderQuestion() {
        const question = this.questions[this.currentQuestion];
        const gameArea = document.getElementById('game-area');
        
        const html = `
            <div class="score-section">
                <p>Question ${this.currentQuestion + 1} of ${this.questions.length}</p>
                <p>Score: ${this.score}</p>
            </div>
            <div class="question">${question.question}</div>
            <div class="answers">
                ${question.answers.map(answer => `
                    <button class="answer-btn" data-answer="${answer}">
                        ${answer}
                    </button>
                `).join('')}
            </div>
        `;
        gameArea.innerHTML = html;

        // Reset timer warning
        const timerFill = document.getElementById('timer-fill');
        timerFill.classList.remove('time-warning');

        // Start timer for new question
        this.startTimer();

        // Add click handlers to answer buttons
        document.querySelectorAll('.answer-btn').forEach(button => {
            button.addEventListener('click', () => this.handleAnswer(button));
        });
    }

    handleAnswer(buttonElement) {
        clearInterval(this.timer);
        const selectedAnswer = buttonElement.dataset.answer;
        const correctAnswer = this.questions[this.currentQuestion].correct_answer;
        
        document.querySelectorAll('.answer-btn').forEach(btn => {
            btn.disabled = true;
            if (btn.dataset.answer === correctAnswer) {
                btn.classList.add('correct');
            } else if (btn.dataset.answer === selectedAnswer) {
                btn.classList.add('incorrect');
            }
        });

        if (selectedAnswer === correctAnswer) {
            this.score++;
            this.correctSound.play().catch(e => console.log('Audio play error:', e));
        } else {
            this.wrongSound.play().catch(e => console.log('Audio play error:', e));
        }

        setTimeout(() => this.proceedToNext(), 1500);
    }

    proceedToNext() {
        if (this.currentQuestion < this.questions.length - 1) {
            this.currentQuestion++;
            this.renderQuestion();
        } else {
            this.endGame();
        }
    }

    endGame() {
        this.updateHighScores();
        this.showHighScores();
    }

    updateHighScores() {
        const highScores = this.getHighScores();
        highScores.push({
            name: this.playerName,
            score: this.score,
            category: this.selectedCategory ? 
                this.categories.find(c => c.id === parseInt(this.selectedCategory))?.name : 
                'Any Category',
            date: new Date().toLocaleDateString()
        });

        // Sort by score (highest first) and keep only top 10
        highScores.sort((a, b) => b.score - a.score);
        const topScores = highScores.slice(0, 10);
        
        // Save to localStorage
        localStorage.setItem('triviaHighScores', JSON.stringify(topScores));
    }

    getHighScores() {
        const scores = localStorage.getItem('triviaHighScores');
        return scores ? JSON.parse(scores) : [];
    }

    clearHighScores() {
        localStorage.removeItem('triviaHighScores');
        this.showHighScores();
    }

    showHighScores() {
        const highScores = this.getHighScores();
        const highScoresList = document.getElementById('high-scores-list');
        
        if (highScores.length === 0) {
            highScoresList.innerHTML = '<p>No high scores yet!</p>';
        } else {
            highScoresList.innerHTML = highScores.map((score, index) => `
                <div class="score-item">
                    <span>${index + 1}. ${score.name}</span>
                    <span>${score.score}/10 - ${score.category}</span>
                    <span>${score.date}</span>
                </div>
            `).join('');
        }

        this.showScreen('high-scores-screen');
    }
}

// start the game when the page loads
window.addEventListener('load', () => {
    new TriviaGame();
});