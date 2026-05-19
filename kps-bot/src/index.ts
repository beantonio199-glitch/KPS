import 'dotenv/config';
      await interaction.reply({
        content: `Valitsit: ${CHOICES[interaction.customId as keyof typeof CHOICES]}`,
        ephemeral: true,
      });

      if (Object.keys(game.choices).length === game.players.size) {
        const values = Object.values(game.choices);

        const hasRock = values.includes('rock');
        const hasPaper = values.includes('paper');
        const hasScissors = values.includes('scissors');

        let losers: string[] = [];

        if (hasRock && hasPaper && hasScissors) {
          losers = [];
        } else if (hasRock && hasScissors) {
          losers = Object.entries(game.choices)
            .filter(([_, v]) => v === 'scissors')
            .map(([id]) => id);
        } else if (hasPaper && hasRock) {
          losers = Object.entries(game.choices)
            .filter(([_, v]) => v === 'rock')
            .map(([id]) => id);
        } else if (hasScissors && hasPaper) {
          losers = Object.entries(game.choices)
            .filter(([_, v]) => v === 'paper')
            .map(([id]) => id);
        }

        losers.forEach(id => {
          game.players.delete(id);
          addLoss(id);
        });

        let desc = '';

        for (const [id, choice] of Object.entries(game.choices)) {
          desc += `<@${id}> → ${CHOICES[choice as keyof typeof CHOICES]}
`;
        }

        if (losers.length === 0) {
          desc += '
🔥 Kaikki selvisivät!';
        } else {
          desc += `
💀 Pudonneet: ${losers.map(id => `<@${id}>`).join(', ')}`;
        }

        const embed = new EmbedBuilder()
          .setTitle('📢 Kierroksen tulokset')
          .setDescription(desc);

        await interaction.channel?.send({ embeds: [embed] });

        game.choices = {};

        // WINNER

        if (game.players.size === 1) {
          const winner = [...game.players][0];

          addWin(winner);

          const winEmbed = new EmbedBuilder()
            .setTitle('🏆 Voittaja!')
            .setDescription(`<@${winner}> voitti Battle Royalen!`);

          await interaction.channel?.send({ embeds: [winEmbed] });

          games.delete(interaction.channelId);
        }
      }
    }
  }
});

client.login(process.env.TOKEN);